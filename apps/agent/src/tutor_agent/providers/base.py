"""Vendor interfaces (§13: keep vendors behind interfaces).

Every one of these is a Protocol, not a base class, so a fake in a test file and
a real SDK wrapper satisfy it without importing each other. Nothing in core/
imports a vendor SDK.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from ..core.cue import CharacterTimings

# ---------------------------------------------------------------------------
# LLM
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TextDelta:
    """A chunk of speech text."""

    text: str


@dataclass(frozen=True)
class ToolCall:
    """A completed tool call. Position in the stream is the cue anchor."""

    id: str
    name: str
    input: dict[str, Any]


@dataclass(frozen=True)
class TurnEnd:
    stop_reason: str


StreamEvent = TextDelta | ToolCall | TurnEnd


@runtime_checkable
class LLMProvider(Protocol):
    """The tutor brain.

    `stream_turn` yields TextDelta and ToolCall events IN ORDER. That ordering
    is load-bearing: it is the only thing that tells us where in the speech a
    canvas action belongs.
    """

    async def stream_turn(
        self,
        *,
        system: str,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]],
    ) -> AsyncIterator[StreamEvent]: ...


# ---------------------------------------------------------------------------
# Speech
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Transcript:
    text: str
    is_final: bool


@runtime_checkable
class STTProvider(Protocol):
    """Streaming speech-to-text. ElevenLabs Scribe v2 Realtime; Deepgram fallback."""

    async def stream_transcript(self, audio: AsyncIterator[bytes]) -> AsyncIterator[Transcript]: ...


@dataclass(frozen=True)
class SynthesisResult:
    audio: bytes
    timings: CharacterTimings
    """Character-level timings aligned to the ORIGINAL input text. Without these
    there is no cue timing, so a TTS provider that can't produce them cannot be
    used in the realtime loop."""


@runtime_checkable
class TTSProvider(Protocol):
    async def synthesize(self, text: str, *, voice_id: str, model: str) -> SynthesisResult: ...


# ---------------------------------------------------------------------------
# Avatar
# ---------------------------------------------------------------------------


@runtime_checkable
class AvatarProvider(Protocol):
    """Renders a talking face from an audio stream and publishes video.

    Providers bill per active minute (~$0.10-0.37), so `pause` is not an
    optimization — leaving the stream hot while the learner works alone on the
    board is a direct cost leak (§14 cheat sheet).
    """

    async def start(self, *, avatar_ref: str) -> None: ...

    async def push_audio(self, audio: bytes) -> None: ...

    async def pause(self) -> None: ...

    async def stop(self) -> None: ...


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    text: str
    uri: str
    score: float


@runtime_checkable
class RetrievalProvider(Protocol):
    """pgvector for MVP, Moss later. Must stay under ~150ms in-loop (§4)."""

    async def search(self, query: str, *, user_id: str, limit: int = 5) -> list[Chunk]: ...
