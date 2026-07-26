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

from ..core.session import SessionConfig, TutorSession
from ..persona import get_persona
from ..providers.anthropic_llm import AnthropicLLM
from ..providers.elevenlabs import ElevenLabsTTS
from .realtime import CANVAS_TOPIC, NUM_CHANNELS, SAMPLE_RATE, LiveKitAdapter

log = logging.getLogger("tutor.worker")

DEFAULT_PERSONA = os.environ.get("TUTOR_PERSONA", "ada")


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
        tts=ElevenLabsTTS(api_key=os.environ["ELEVENLABS_API_KEY"]),
        channel=adapter,
        config=SessionConfig(),
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
        asyncio.create_task(_transcribe(track))

    async def _transcribe(track: rtc.Track) -> None:
        """Stream the learner's audio through STT and drive turns.

        NOTE: this is the one piece still to wire. livekit-plugins-elevenlabs
        exposes Scribe v2 as an STT node; drop it in here, and on each final
        transcript:

            nonlocal speech_ended_at
            speech_ended_at = time.perf_counter()
            await session.barge_in()       # kill the previous turn's cues
            asyncio.create_task(run_turn(text))

        Barge-in must fire on the FIRST interim transcript, not the final one —
        waiting for finalization means the tutor talks over the learner for
        several hundred milliseconds.
        """
        log.warning("STT not wired yet — see _transcribe in %s", __file__)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    for required in ("ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "LIVEKIT_URL"):
        if not os.environ.get(required):
            raise SystemExit(f"{required} is not set — did you source .env?")
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))


if __name__ == "__main__":
    main()
