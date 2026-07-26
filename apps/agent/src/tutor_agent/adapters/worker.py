"""LiveKit Agents entrypoint: connect a room to a TutorSession.

    set -a && . ./.env && set +a
    uv run python -m tutor_agent.adapters.worker dev

The worker owns the clock for the ≤1.2s budget (§4): it timestamps
end-of-user-speech and measures to the first audio frame published. TurnResult
only measures from turn start, which excludes STT finalization.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time

from livekit import agents, rtc
from livekit.plugins import elevenlabs as lk_elevenlabs

from ..core.session import SessionConfig, TutorSession
from ..persona import PersonaNotFoundError, PersonaSpec, get_persona
from ..providers.anthropic_llm import AnthropicLLM
from ..providers.factory import make_tts
from ..providers.livekit_avatar import (
    AVATAR_SAMPLE_RATE,
    AvatarCredentials,
    LemonSliceAvatar,
    LemonSliceConfig,
    LiveKitAvatar,
    SimliAvatar,
    SimliConfig,
    known_avatar_identities,
)
from .realtime import CANVAS_TOPIC, NUM_CHANNELS, SAMPLE_RATE, LiveKitAdapter

log = logging.getLogger("tutor.worker")

DEFAULT_PERSONA = os.environ.get("TUTOR_PERSONA", "ada")

# End-of-user-speech to first tutor audio (§4).
BUDGET_MS = 1200


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 1)


class TurnMetricsSink:
    """Append one JSON object per turn to TUTOR_METRICS_PATH.

    A live session is the only place the latency numbers exist, and reading them
    out of scrollback afterwards does not work — you want to sort by
    firstAudioMs, not scroll. Disabled unless the path is set, and a broken sink
    must never take down a session, so write errors are logged once and dropped.
    """

    def __init__(self, path: str | None) -> None:
        self.path = path
        self._warned = False
        if path:
            log.info("writing per-turn metrics to %s", path)

    def record(self, row: dict) -> None:
        if not self.path:
            return
        try:
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(row) + "\n")
        except OSError as exc:
            if not self._warned:
                log.warning("metrics sink disabled: %s", exc)
                self._warned = True


# Scribe v2 Realtime input rate. Distinct from SAMPLE_RATE, which is the 48kHz
# output rate we publish at.
STT_SAMPLE_RATE = 16_000

# The single biggest latency knob in the whole loop, and it isn't in the model.
# The plugin defaults to min_silence_duration_ms=2500 / vad_silence_threshold_secs=1.5,
# which makes every turn wait 2.5s of silence before finalizing — more than the
# entire 1.2s budget, spent doing nothing.
#
# 600ms is a tradeoff, not a free win: too low and a learner pausing mid-thought
# gets cut off. Worth re-testing at 600/900/1200 with real speech.
VAD_OPTIONS = {
    "min_silence_duration_ms": 600,
    "vad_silence_threshold_secs": 0.5,
    "min_speech_duration_ms": 250,
}


async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect()
    # Which tutor teaches this room is the room's choice, not the process's:
    # the session endpoint (server/live.ts) names a persona in the room
    # metadata. Rooms without metadata keep the old TUTOR_PERSONA behavior.
    persona_slug, owner = _persona_request(ctx.room.metadata)
    # psycopg is synchronous; one lookup at session start, off the event loop.
    persona = await asyncio.to_thread(_load_persona, persona_slug, owner)
    log.info("session starting with persona %s", persona.id)

    # Publish the tutor's audio track before anything else, so the first
    # synthesized segment has somewhere to go the instant it exists.
    source = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
    track = rtc.LocalAudioTrack.create_audio_track("tutor-voice", source)
    await ctx.room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )

    adapter = LiveKitAdapter(room=ctx.room, audio_source=source)
    pool, retrieval = await _maybe_open_retrieval()
    session = TutorSession(
        persona=persona,
        llm=AnthropicLLM(model="claude-sonnet-5", effort="low"),
        # The persona's voice.provider picks the vendor. PCM at LiveKit's
        # native rate — mp3 into an AudioSource is noise.
        tts=make_tts(persona, sample_rate=SAMPLE_RATE),
        channel=adapter,
        retrieval=retrieval,
        config=SessionConfig(),
        # Retrieval ACLs follow the learner the room was created for.
        user_id=owner or os.environ.get("TUTOR_USER_ID", "dev"),
    )
    if pool is not None:
        ctx.add_shutdown_callback(pool.close)

    stt = lk_elevenlabs.STT(
        # Explicit: the plugin's env fallback reads ELEVEN_API_KEY, not the
        # ELEVENLABS_API_KEY name everything else in this repo documents.
        api_key=os.environ["ELEVENLABS_API_KEY"],
        use_realtime=True,
        sample_rate=STT_SAMPLE_RATE,
        server_vad=VAD_OPTIONS,
    )

    avatar = await _maybe_start_avatar(ctx, persona)
    if avatar is not None and avatar.is_active:
        # Simli republishes the audio it receives, so publishing to our own
        # track too would play everything twice, slightly offset. Hand audio to
        # the avatar only, and re-request TTS at Simli's ingest rate.
        adapter.audio_source = None
        session.avatar = avatar
        # Avatars ingest at 16k, so re-build the provider at that rate.
        session.tts = make_tts(persona, sample_rate=AVATAR_SAMPLE_RATE)
        log.info(
            "avatar active (%s) — audio routed through it at %dHz",
            persona.avatar.provider,
            AVATAR_SAMPLE_RATE,
        )

    turn_lock = asyncio.Lock()
    speech_ended_at: float | None = None
    metrics = TurnMetricsSink(os.environ.get("TUTOR_METRICS_PATH"))

    async def run_turn(transcript: str) -> None:
        """One turn. Serialized so a fast follow-up queues instead of racing."""
        nonlocal speech_ended_at
        async with turn_lock:
            started = time.perf_counter()
            # STT finalization is dead time the learner hears as silence, and
            # TurnResult can't see it — measure it here or not at all.
            stt_finalize_ms = (
                (started - speech_ended_at) * 1000 if speech_ended_at is not None else None
            )
            result = await session.handle_transcript(transcript)
            wall_ms = (time.perf_counter() - started) * 1000

            total = (
                (stt_finalize_ms or 0.0) + result.first_audio_ms
                if result.first_audio_ms is not None
                else None
            )
            if total is not None:
                log.info(
                    "turn %s first-audio %.0fms (%s, budget %dms) actions=%d dropped=%d",
                    result.turn_id,
                    total,
                    "OK" if total <= BUDGET_MS else "OVER",
                    BUDGET_MS,
                    len(result.actions),
                    len(result.dropped_actions),
                )
            metrics.record(
                {
                    "turnId": result.turn_id,
                    "persona": persona.id,
                    "avatar": persona.avatar.provider if avatar is not None else None,
                    "transcriptChars": len(transcript),
                    # The three legs of the budget, separated so a regression
                    # points at a subsystem instead of at "the loop got slower".
                    "sttFinalizeMs": _round(stt_finalize_ms),
                    "modelToFirstAudioMs": _round(result.first_audio_ms),
                    "firstAudioMs": _round(total),
                    "withinBudget": None if total is None else total <= BUDGET_MS,
                    "turnWallMs": _round(wall_ms),
                    "actions": len(result.actions),
                    "droppedActions": [name for name, _ in result.dropped_actions],
                    "cancelled": result.cancelled,
                    "stopReason": result.stop_reason,
                    "speechChars": len(result.speech_text),
                }
            )
            speech_ended_at = None

    # -- inbound: student events from the canvas client ---------------------

    @ctx.room.on("data_received")
    def _on_data(packet: rtc.DataPacket) -> None:
        if packet.topic != CANVAS_TOPIC:
            return
        try:
            message = json.loads(packet.data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            log.warning("undecodable data packet from %s", packet.participant)
            return
        if message.get("type") == "student_event":
            # Folded into the next turn's context (§5.3), not acted on now.
            session.student_events([message])

    # -- inbound: the learner speaking --------------------------------------

    @ctx.room.on("track_subscribed")
    def _on_track(
        track: rtc.Track,
        publication: rtc.TrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if participant.identity in known_avatar_identities():
            # The avatar publishes audio on our behalf; transcribing it would
            # make the tutor answer itself.
            return
        asyncio.create_task(_transcribe(track))

    async def _transcribe(track: rtc.Track) -> None:
        """Stream the learner's audio through Scribe v2 and drive turns."""
        stream = stt.stream()

        async def pump() -> None:
            audio = rtc.AudioStream(track, sample_rate=STT_SAMPLE_RATE, num_channels=1)
            async for event in audio:
                stream.push_frame(event.frame)

        pump_task = asyncio.create_task(pump())
        try:
            async for event in stream:
                await _on_speech_event(event)
        finally:
            pump_task.cancel()
            await stream.aclose()

    async def _on_speech_event(event: agents.stt.SpeechEvent) -> None:
        nonlocal speech_ended_at

        if event.type == agents.stt.SpeechEventType.START_OF_SPEECH:
            # Barge-in fires HERE, not on the final transcript. Waiting for
            # finalization means the tutor keeps talking over the learner for
            # the whole VAD window.
            await session.barge_in()

        elif event.type == agents.stt.SpeechEventType.END_OF_SPEECH:
            # The budget clock (§4) starts when the learner stops talking.
            speech_ended_at = time.perf_counter()

        elif event.type == agents.stt.SpeechEventType.FINAL_TRANSCRIPT:
            text = event.alternatives[0].text.strip() if event.alternatives else ""
            if not text:
                return
            log.info("learner: %s", text)
            # Not awaited: the STT loop must keep consuming so barge-in during
            # the tutor's reply still registers.
            asyncio.create_task(run_turn(text))


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    for required in ("ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "LIVEKIT_URL"):
        if not os.environ.get(required):
            raise SystemExit(f"{required} is not set — did you source .env?")
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))


if __name__ == "__main__":
    main()


def _persona_request(metadata: str | None) -> tuple[str, str | None]:
    """(persona slug, owner) for this room.

    The session endpoint (server/live.ts) writes {"persona": ..., "owner": ...}
    into the room metadata at creation. Rooms created any other way — a
    livekit-server --dev join, the cue-inspector replay script — carry no
    metadata and fall back to TUTOR_PERSONA, so every existing workflow keeps
    working unchanged.
    """
    if metadata:
        try:
            data = json.loads(metadata)
        except json.JSONDecodeError:
            log.warning("room metadata is not JSON — using the default persona")
        else:
            if isinstance(data, dict) and data.get("persona"):
                return str(data["persona"]), data.get("owner") or None
    return DEFAULT_PERSONA, None


def _load_persona(slug: str, owner: str | None) -> PersonaSpec:
    """Resolve a persona: database first, curated YAML second.

    Custom tutors created through apps/api live in Postgres; the YAML dir holds
    only the curated library. A missing or unreachable database degrades to
    exactly the behavior the worker had before (YAML only) rather than taking
    the voice loop down.
    """
    dsn = os.environ.get("DATABASE_URL")
    if dsn:
        try:
            import psycopg

            from ..persona.store import PostgresPersonaStore

            with psycopg.connect(dsn, autocommit=True) as conn:
                store = PostgresPersonaStore(conn)
                # Owner's persona shadows a library persona with the same slug.
                for scope in (owner, None) if owner else (None,):
                    try:
                        persona = store.get(slug, scope)
                    except PersonaNotFoundError:
                        continue
                    if persona.is_revoked:
                        # Same rule get_persona() enforces for YAML (§9):
                        # revoked means refuse, never fall through.
                        raise PersonaNotFoundError(
                            f"persona {slug!r} was revoked and can no longer be used"
                        )
                    return persona
        except PersonaNotFoundError:
            raise
        except Exception:
            log.exception("persona store lookup failed — trying the YAML library")
    return get_persona(slug)


async def _maybe_open_retrieval():
    """Open the sync-plane index if one is configured, else run without it.

    Returns (pool, provider). Retrieval is optional the same way the avatar is:
    a tutor with no indexed materials is a worse tutor, not a broken one, and
    a database that is down must not take the voice loop with it.

    The pool is opened once per worker process, not per turn — connection setup
    does not fit inside the 150ms in-loop budget (§4).
    """
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        log.info("retrieval disabled — set DATABASE_URL to teach from synced materials")
        return None, None

    try:
        import asyncpg

        from ..retrieval.embeddings import HashingEmbeddings, VoyageEmbeddings
        from ..retrieval.pgvector import PgVectorRetrieval

        voyage_key = os.environ.get("VOYAGE_API_KEY")
        if voyage_key:
            embeddings = VoyageEmbeddings(api_key=voyage_key)
        else:
            # Lexical, not semantic. Fine for a local demo, wrong for a real
            # session — say so rather than quietly returning bad matches.
            log.warning(
                "VOYAGE_API_KEY unset — falling back to hashing embeddings. "
                "Retrieval will be keyword-ish, not semantic."
            )
            embeddings = HashingEmbeddings()

        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=4)
        log.info("retrieval enabled against %s", dsn.rsplit("@", 1)[-1])
        return pool, PgVectorRetrieval(pool=pool, embeddings=embeddings)
    except Exception:
        log.exception("could not open retrieval — continuing without indexed materials")
        return None, None


async def _maybe_start_avatar(ctx: agents.JobContext, persona) -> LiveKitAvatar | None:
    """Start the avatar the persona asks for, if credentials are present.
    Returns None rather than raising: a missing key or a vendor outage should
    degrade the session to voice-only, not end it.
    """
    provider = persona.avatar.provider
    if provider in (None, "", "none"):
        return None

    credentials = AvatarCredentials(
        room=ctx.room,
        local_identity=ctx.local_participant_identity,
        livekit_url=os.environ["LIVEKIT_URL"],
        livekit_api_key=os.environ["LIVEKIT_API_KEY"],
        livekit_api_secret=os.environ["LIVEKIT_API_SECRET"],
    )

    avatar: LiveKitAvatar
    if provider == "lemonslice":
        api_key = os.environ.get("LEMONSLICE_API_KEY")
        if not api_key:
            log.info("avatar disabled — set LEMONSLICE_API_KEY to enable")
            return None
        ref = persona.avatar.avatar_ref or os.environ.get("LEMONSLICE_AVATAR_REF", "")
        avatar = LemonSliceAvatar(config=LemonSliceConfig(api_key=api_key), credentials=credentials)
    elif provider == "simli":
        api_key = os.environ.get("SIMLI_API_KEY")
        ref = persona.avatar.avatar_ref or os.environ.get("SIMLI_FACE_ID", "")
        if not api_key or not ref:
            log.info("avatar disabled — set SIMLI_API_KEY and SIMLI_FACE_ID to enable")
            return None
        avatar = SimliAvatar(
            config=SimliConfig(api_key=api_key, face_id=ref), credentials=credentials
        )
    else:
        log.warning("persona %s asks for unknown avatar provider %r", persona.id, provider)
        return None

    await avatar.start(avatar_ref=ref)
    return avatar if avatar.is_active else None
