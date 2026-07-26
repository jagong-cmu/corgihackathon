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
from ..persona import get_persona
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
    persona = get_persona(DEFAULT_PERSONA)
    log.info("session starting with persona %s", persona.id)

    # Publish the tutor's audio track before anything else, so the first
    # synthesized segment has somewhere to go the instant it exists.
    source = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
    track = rtc.LocalAudioTrack.create_audio_track("tutor-voice", source)
    await ctx.room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )

    adapter = LiveKitAdapter(room=ctx.room, audio_source=source)
    session = TutorSession(
        persona=persona,
        llm=AnthropicLLM(model="claude-sonnet-5", effort="low"),
        # The persona's voice.provider picks the vendor. PCM at LiveKit's
        # native rate — mp3 into an AudioSource is noise.
        tts=make_tts(persona, sample_rate=SAMPLE_RATE),
        channel=adapter,
        config=SessionConfig(),
    )

    stt = lk_elevenlabs.STT(
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

    async def run_turn(transcript: str) -> None:
        """One turn. Serialized so a fast follow-up queues instead of racing."""
        nonlocal speech_ended_at
        async with turn_lock:
            started = time.perf_counter()
            result = await session.handle_transcript(transcript)

            if result.first_audio_ms is not None:
                # Budget is measured from end-of-user-speech, not turn start.
                base = speech_ended_at if speech_ended_at is not None else started
                total = (started - base) * 1000 + result.first_audio_ms
                verdict = "OK" if total <= 1200 else "OVER"
                log.info(
                    "turn %s first-audio %.0fms (%s, budget 1200ms) actions=%d dropped=%d",
                    result.turn_id,
                    total,
                    verdict,
                    len(result.actions),
                    len(result.dropped_actions),
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
