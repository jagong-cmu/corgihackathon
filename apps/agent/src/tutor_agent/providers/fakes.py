"""Offline fakes. The entire loop runs against these with zero API keys.

These are not throwaway stubs — they are the substrate the test suite runs on,
so they behave like the real thing in every way the core depends on: ordered
streams, character-aligned timings, realistic latency. Anything the fakes let
you get away with, the real providers will too.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

from ..core.cue import CharacterTimings, synthetic_timings
from .base import (
    AudioChunk,
    Chunk,
    Principal,
    StreamEvent,
    SynthesisResult,
    TextDelta,
    ToolCall,
    Transcript,
    TurnEnd,
)


@dataclass
class ScriptedTurn:
    """One scripted assistant turn: an ordered mix of speech and tool calls.

    Written as a flat list so a test can express exactly the interleaving it
    cares about:

        ScriptedTurn(events=[
            "Okay, watch this. ",
            ("sim_control", {"id": "sim_a", "op": "play"}),
            "Both arrows show up at the same instant.",
        ])
    """

    events: list[str | tuple[str, dict[str, Any]]]
    stop_reason: str = "end_turn"


class FakeLLM:
    """Replays scripted turns in order. Satisfies LLMProvider."""

    def __init__(self, turns: Sequence[ScriptedTurn], *, delta_chars: int = 12) -> None:
        self._turns = list(turns)
        self._index = 0
        self._delta_chars = delta_chars
        self.calls: list[dict[str, Any]] = []
        """Every request made, for assertions about prompt assembly."""

        self.tool_events: list[ToolCall] = []
        """Every ToolCall yielded, AFTER the consumer handled it — so tests
        can assert on the `error` feedback the session wrote back."""

    async def stream_turn(
        self,
        *,
        system: str,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]],
    ) -> AsyncIterator[StreamEvent]:
        self.calls.append({"system": system, "messages": list(messages), "tools": list(tools)})

        if self._index >= len(self._turns):
            yield TurnEnd(stop_reason="end_turn")
            return

        turn = self._turns[self._index]
        self._index += 1

        for i, event in enumerate(turn.events):
            if isinstance(event, str):
                # Chunk text the way a real stream does, so offset accumulation
                # is exercised rather than assumed.
                for start in range(0, len(event), self._delta_chars):
                    yield TextDelta(text=event[start : start + self._delta_chars])
            else:
                name, payload = event
                call = ToolCall(id=f"toolu_fake_{self._index}_{i}", name=name, input=payload)
                yield call
                self.tool_events.append(call)

        yield TurnEnd(stop_reason=turn.stop_reason)


class FakeTTS:
    """Deterministic synthetic timings at a configurable speaking rate."""

    def __init__(self, words_per_minute: float = 150.0, latency_ms: int = 0) -> None:
        self.words_per_minute = words_per_minute
        self.latency_ms = latency_ms
        self.synthesized: list[str] = []

    async def synthesize(self, text: str, *, voice_id: str, model: str) -> SynthesisResult:
        if self.latency_ms:
            await asyncio.sleep(self.latency_ms / 1000.0)
        self.synthesized.append(text)
        timings: CharacterTimings = synthetic_timings(text, self.words_per_minute)
        # One byte per character stands in for audio — the core never inspects it.
        return SynthesisResult(audio=text.encode("utf-8"), timings=timings)


class FakeSTT:
    """Yields a fixed list of transcripts."""

    def __init__(self, transcripts: Sequence[str]) -> None:
        self._transcripts = list(transcripts)

    async def stream_transcript(self, audio: AsyncIterator[bytes]) -> AsyncIterator[Transcript]:
        for text in self._transcripts:
            yield Transcript(text=text, is_final=True)


@dataclass
class FakeAvatar:
    """Records lifecycle calls so tests can assert the stream gets paused."""

    started_with: str | None = None
    audio_chunks: list[bytes] = field(default_factory=list)
    flushed: int = 0
    interrupted: int = 0
    paused: int = 0
    stopped: bool = False

    async def start(self, *, avatar_ref: str) -> None:
        self.started_with = avatar_ref

    async def push_audio(self, audio: bytes) -> None:
        self.audio_chunks.append(audio)

    async def flush(self) -> None:
        self.flushed += 1

    async def interrupt(self) -> None:
        self.interrupted += 1

    async def pause(self) -> None:
        self.paused += 1

    async def stop(self) -> None:
        self.stopped = True


class FakeRetrieval:
    """Returns canned chunks after a simulated delay.

    The delay defaults to 100ms on purpose: the ≤150ms in-loop retrieval budget
    (§4) should be felt during development, not discovered at integration.
    """

    def __init__(self, chunks: Sequence[Chunk] = (), latency_ms: int = 100) -> None:
        self._chunks = list(chunks)
        self.latency_ms = latency_ms
        self.queries: list[str] = []
        self.principals: list[Principal] = []
        """Every principal searched with, so a test can assert the core passes
        the requester through rather than dropping it (§13)."""

    async def search(self, query: str, *, principal: Principal, limit: int = 5) -> list[Chunk]:
        self.queries.append(query)
        self.principals.append(principal)
        if self.latency_ms:
            await asyncio.sleep(self.latency_ms / 1000.0)
        return self._chunks[:limit]


class FakeStreamingTTS(FakeTTS):
    """FakeTTS that also satisfies StreamingTTSProvider.

    Splits each segment into N chunks and reproduces the two properties
    measured against the real API: character times are absolute across chunks,
    and some chunks carry audio with no alignment. Code that only works when
    every chunk has alignment will fail here, which is the point.
    """

    def __init__(
        self,
        words_per_minute: float = 150.0,
        latency_ms: int = 0,
        chunks: int = 3,
        silent_chunk_every: int = 2,
    ) -> None:
        super().__init__(words_per_minute=words_per_minute, latency_ms=latency_ms)
        self.chunks = chunks
        self.silent_chunk_every = silent_chunk_every
        self.stream_calls = 0

    async def synthesize_stream(
        self, text: str, *, voice_id: str, model: str
    ) -> AsyncIterator[AudioChunk]:
        self.stream_calls += 1
        self.synthesized.append(text)
        timings = synthetic_timings(text, self.words_per_minute)

        if not text:
            return

        size = max(1, -(-len(text) // self.chunks))  # ceil
        emitted = 0
        index = 0
        while emitted < len(text):
            piece = text[emitted : emitted + size]
            lo, hi = emitted, emitted + len(piece)

            # Interleave an audio-only chunk, as the real API does.
            if self.silent_chunk_every and index % self.silent_chunk_every == 1:
                yield AudioChunk(audio=b"\x00\x00", characters="", start_ms=[], end_ms=[])

            yield AudioChunk(
                audio=piece.encode("utf-8"),
                characters=piece,
                start_ms=timings.start_ms[lo:hi],
                end_ms=timings.end_ms[lo:hi],
            )
            emitted = hi
            index += 1
