"""Vendor interfaces (§13: keep vendors behind interfaces).

Every one of these is a Protocol, not a base class, so a fake in a test file and
a real SDK wrapper satisfy it without importing each other. Nothing in core/
imports a vendor SDK.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

if TYPE_CHECKING:
    # Annotation-only. A runtime import here would form a cycle:
    #   providers.base -> core (package __init__) -> core.session -> providers.base
    # `from __future__ import annotations` keeps the dataclass field lazy.
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


@dataclass(frozen=True)
class AudioChunk:
    """One chunk of a streamed synthesis.

    `characters` may be empty — some chunks carry audio with no alignment.
    Character times are ABSOLUTE across the whole segment, not relative to this
    chunk, so a consumer concatenates the arrays without offset arithmetic.
    """

    audio: bytes
    characters: str
    start_ms: list[int]
    end_ms: list[int]


@runtime_checkable
class StreamingTTSProvider(Protocol):
    """Optional. A TTS provider that can emit audio before synthesis finishes.

    The session prefers this when available: pushing audio per chunk rather than
    per segment is the difference between ~1s and ~330ms to first sound.
    Providers that don't implement it still work via TTSProvider.
    """

    def synthesize_stream(
        self, text: str, *, voice_id: str, model: str
    ) -> AsyncIterator[AudioChunk]: ...


# ---------------------------------------------------------------------------
# Avatar
# ---------------------------------------------------------------------------


@runtime_checkable
class AvatarProvider(Protocol):
    """Renders a talking face from an audio stream and publishes video."""

    async def start(self, *, avatar_ref: str) -> None: ...

    async def push_audio(self, audio: bytes) -> None: ...

    async def flush(self) -> None:
        """One turn's audio is complete — mark the segment boundary.

        Stream-transport avatars (LiveKit data streams) carry each segment on
        its own stream and can only recover from a barge-in at a segment
        boundary, so the session must call this once per turn after the last
        push_audio.
        """

    async def interrupt(self) -> None:
        """Drop queued audio the learner has interrupted.

        Distinct from `pause` on purpose. This one is latency-critical and fires
        on every barge-in: without it the face keeps lip-syncing a sentence the
        learner already talked over.
        """

    async def pause(self) -> None:
        """Stand the stream down while the learner works solo on the board.

        Providers bill per active minute (~$0.10-0.37), so this is a cost lever,
        not an optimization (§14 cheat sheet). Note that clearing the audio
        buffer alone does not stop the meter — a provider that bills for an idle
        session must end it in `stop` and re-`start` later.
        """

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
    title: str | None = None


@dataclass(frozen=True)
class Principal:
    """Who is asking, for ACL enforcement at query time (§13).

    Two fields because two things grant access. `user_id` is ownership: your own
    uploads. `groups` are the identities the upstream source knows you by —
    Merge's ACL model records permissions against provider-side users and groups,
    so a chunk from a shared Drive folder is readable by whoever holds one of
    those, which is not necessarily the row's owner.

    Passing this rather than a bare user_id is deliberate. §13 requires filtering
    on `doc_chunks.acl` at *query* time, not only at ingestion, because a
    permission revoked upstream must take effect on the next question rather than
    the next resync. A signature with nowhere to put the requester's groups
    quietly makes that impossible, which is how ingestion-time-only filtering
    happens by accident.
    """

    user_id: str
    groups: frozenset[str] = frozenset()

    @staticmethod
    def owner(user_id: str) -> Principal:
        """The common case: the learner reading their own materials."""
        return Principal(user_id=user_id)


@runtime_checkable
class RetrievalProvider(Protocol):
    """pgvector for MVP, Moss later. Must stay under ~150ms in-loop (§4)."""

    async def search(self, query: str, *, principal: Principal, limit: int = 5) -> list[Chunk]: ...
