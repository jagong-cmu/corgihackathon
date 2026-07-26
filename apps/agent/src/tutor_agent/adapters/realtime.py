"""LiveKit realtime adapter.

This is transport only. It publishes audio, serializes canvas actions onto the
data channel, and forwards student events into the core. There is NO tutoring
logic here and there must never be (§13) — if you find yourself deciding what
the tutor should say or draw in this file, it belongs in core/session.py.

Requires the `livekit` extra:

    uv sync --extra livekit
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from livekit import rtc

from ..core.channel import Channel, ChannelCapabilities
from ..core.cue import TimedAction
from ..core.protocol import protocol_version

log = logging.getLogger(__name__)

# LiveKit data-channel topic. The client subscribes to this specifically so
# canvas traffic doesn't get mixed with other application messages.
CANVAS_TOPIC = "canvas"

# 48kHz mono is LiveKit's native rate; anything else forces a resample on the
# publish path and adds latency we can't afford in the loop.
SAMPLE_RATE = 48_000
NUM_CHANNELS = 1


@dataclass
class LiveKitAdapter:
    """Satisfies ChannelAdapter over a LiveKit room."""

    room: rtc.Room
    audio_source: rtc.AudioSource | None = None
    _caps: ChannelCapabilities = field(default_factory=ChannelCapabilities.realtime)

    @property
    def channel(self) -> Channel:
        return Channel.WEB

    @property
    def capabilities(self) -> ChannelCapabilities:
        return self._caps

    async def send_audio(self, audio: bytes) -> None:
        """Push a synthesized segment onto the published audio track.

        `audio` is whatever the TTS provider returned. ElevenLabs gives us mp3
        by default; the worker configures PCM output so this can go straight to
        the source without a decode step in the hot path.
        """
        if self.audio_source is None:
            log.warning("send_audio called before the audio track was published")
            return
        frame = rtc.AudioFrame(
            data=audio,
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
            samples_per_channel=len(audio) // (2 * NUM_CHANNELS),
        )
        await self.audio_source.capture_frame(frame)

    async def send_action(self, turn_id: str, action: TimedAction) -> None:
        await self._publish(
            {
                "type": "canvas_action",
                "v": protocol_version(),
                "turnId": turn_id,
                "seq": action.seq,
                "cueMs": action.cue_ms,
                "action": action.action,
            }
        )

    async def cancel_turn(self, turn_id: str, reason: str) -> None:
        await self._publish({"type": "cancel_turn", "turnId": turn_id, "reason": reason})

    async def _publish(self, payload: dict) -> None:
        # reliable=True: a dropped canvas action is a missing arrow the learner
        # was just told to look at. The volume is tiny (a few hundred bytes per
        # action), so reliability costs us nothing meaningful.
        await self.room.local_participant.publish_data(
            json.dumps(payload).encode("utf-8"),
            reliable=True,
            topic=CANVAS_TOPIC,
        )
