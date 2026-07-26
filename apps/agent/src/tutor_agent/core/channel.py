"""The channel-adapter seam (§8).

Built in Phase 1 even though only the realtime adapter exists, because
retrofitting channel-agnosticism is a rewrite. The rule, from §13:

    Channel adapters contain no tutoring logic. If you find yourself writing
    pedagogy in an adapter, stop and move it to the core.

An adapter's whole job is: hand the core input, take its output, move bytes.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol, runtime_checkable

from .cue import TimedAction


class Channel(StrEnum):
    WEB = "web"
    IMESSAGE = "imessage"
    SMS = "sms"
    WHATSAPP = "whatsapp"
    PHONE = "phone"


@dataclass(frozen=True)
class ChannelCapabilities:
    """What a channel can actually do. The core adapts its output to these
    rather than each adapter reimplementing the decision."""

    streams_audio: bool
    """False for text channels — the core skips TTS and fires all cues at 0."""

    renders_canvas_live: bool
    """False for messaging, where a headless renderer rasterizes the same action
    stream into a PNG server-side (§8)."""

    supports_barge_in: bool

    @staticmethod
    def realtime() -> ChannelCapabilities:
        return ChannelCapabilities(
            streams_audio=True, renders_canvas_live=True, supports_barge_in=True
        )

    @staticmethod
    def messaging() -> ChannelCapabilities:
        return ChannelCapabilities(
            streams_audio=False, renders_canvas_live=False, supports_barge_in=False
        )

    @staticmethod
    def voice_only() -> ChannelCapabilities:
        """Photon phone calls: the realtime pipeline minus avatar and canvas."""
        return ChannelCapabilities(
            streams_audio=True, renders_canvas_live=False, supports_barge_in=True
        )


@runtime_checkable
class ChannelAdapter(Protocol):
    """Transport for one channel."""

    @property
    def channel(self) -> Channel: ...

    @property
    def capabilities(self) -> ChannelCapabilities: ...

    async def send_audio(self, audio: bytes) -> None: ...

    async def send_action(self, turn_id: str, action: TimedAction) -> None:
        """Emit one canvas_action frame. The adapter serializes to the §4
        envelope; it does not decide what or when to send."""

    async def cancel_turn(self, turn_id: str, reason: str) -> None: ...


@dataclass
class RecordingAdapter:
    """In-memory adapter for tests and for the CLI dry-run.

    Records everything the core emitted so a test can assert on the exact wire
    frames rather than on internal state.
    """

    channel_kind: Channel = Channel.WEB
    caps: ChannelCapabilities | None = None

    def __post_init__(self) -> None:
        self.audio: list[bytes] = []
        self.frames: list[dict[str, Any]] = []
        self.cancellations: list[tuple[str, str]] = []
        self._caps = self.caps or ChannelCapabilities.realtime()

    @property
    def channel(self) -> Channel:
        return self.channel_kind

    @property
    def capabilities(self) -> ChannelCapabilities:
        return self._caps

    async def send_audio(self, audio: bytes) -> None:
        self.audio.append(audio)

    async def send_action(self, turn_id: str, action: TimedAction) -> None:
        self.frames.append(
            {
                "type": "canvas_action",
                "turnId": turn_id,
                "seq": action.seq,
                "cueMs": action.cue_ms,
                "action": action.action,
            }
        )

    async def cancel_turn(self, turn_id: str, reason: str) -> None:
        self.cancellations.append((turn_id, reason))
