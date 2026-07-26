"""Split a streaming text feed into sentences for incremental synthesis.

Time-to-first-audio is dominated by how long we wait before calling TTS at all.
Synthesizing the whole turn at once means waiting for the entire LLM response;
synthesizing per sentence means waiting for the first clause.

## The contiguity invariant

Chunks must concatenate to EXACTLY the text that was fed in — no trimming, no
normalization, nothing dropped. Cue timing maps character offsets in the full
speech text onto per-segment timing arrays, so a single swallowed space shifts
every subsequent cue. `test_chunking.py` asserts this on every case.
"""

from __future__ import annotations

_TERMINATORS = frozenset(".!?")
_CLAUSE_BREAKS = frozenset(",;:—–")
_CLOSERS = frozenset("\"')]}")


class SentenceChunker:
    """Accumulates streamed text and emits complete sentences.

    Not a general-purpose sentence splitter. It is deliberately eager: an
    over-split costs one extra TTS call, while an under-split costs latency on
    every turn. The only case it works hard to avoid is splitting inside a
    decimal, which mangles spoken numbers.
    """

    def __init__(
        self,
        min_chars: int = 12,
        max_chars: int = 320,
        first_chunk_max_chars: int = 60,
    ) -> None:
        self.min_chars = min_chars
        """Don't emit a fragment shorter than this — 'Mm.' alone is a wasted
        request and TTS prosody suffers on very short inputs."""

        self.max_chars = max_chars
        """Force a flush at a word boundary past this, so a model that runs on
        without punctuation can't stall audio indefinitely."""

        self.first_chunk_max_chars = first_chunk_max_chars
        """The opening chunk also breaks on clause boundaries (commas, dashes),
        not just sentence ends.

        Time-to-first-audio is the number the latency budget measures, and a
        tutor's opening sentence is often long: waiting for the full stop on
        'Okay, so — this one factors into two binomials, and the whole trick
        is...' costs well over a second before a single sound comes out.
        Breaking at the first dash gets audio flowing while the rest of the
        sentence is still being generated. Only the FIRST chunk does this —
        clause-splitting every chunk would chop the prosody up throughout."""

        self._buffer = ""
        self._emitted_any = False

    def feed(self, text: str) -> list[str]:
        """Add streamed text; return any chunks that are now complete."""
        self._buffer += text
        chunks: list[str] = []
        while True:
            cut = self._find_cut()
            if cut is None:
                break
            chunks.append(self._buffer[:cut])
            self._buffer = self._buffer[cut:]
            self._emitted_any = True
        return chunks

    def flush(self) -> str:
        """Return whatever is left. Call at a round boundary or end of turn."""
        remaining, self._buffer = self._buffer, ""
        if remaining:
            self._emitted_any = True
        return remaining

    @property
    def pending(self) -> str:
        return self._buffer

    # -- internals ----------------------------------------------------------

    def _find_cut(self) -> int | None:
        """Index to split at, or None if no complete chunk is buffered.

        The cut lands AFTER the terminator, its closing quotes, and any
        trailing whitespace, so chunks stay contiguous.
        """
        buffer = self._buffer

        for i, char in enumerate(buffer):
            if char not in _TERMINATORS:
                continue
            if char == "." and self._is_decimal_point(buffer, i):
                continue

            end = i + 1
            while end < len(buffer) and buffer[end] in _CLOSERS:
                end += 1

            # Require a following character to confirm the sentence really
            # ended — otherwise a buffer ending in "." emits before we know
            # whether the next delta is a digit or a new sentence.
            # `break`, not `return`: there are no later terminators to find,
            # but the clause and max-length rules below still apply.
            if end >= len(buffer):
                break

            if not buffer[end].isspace():
                continue

            while end < len(buffer) and buffer[end].isspace():
                end += 1
            # Whitespace ran to the end: more may still be coming.
            if end >= len(buffer) and buffer[-1].isspace():
                break

            if end >= self.min_chars:
                return end

        # Opening chunk only: also break at a clause boundary, to get audio
        # out before a long first sentence finishes generating.
        if not self._emitted_any:
            clause_cut = self._clause_cut(buffer)
            if clause_cut is not None:
                return clause_cut

        if len(buffer) >= self.max_chars:
            return self._word_boundary_before(self.max_chars)
        return None

    def _clause_cut(self, buffer: str) -> int | None:
        for i, char in enumerate(buffer):
            if char not in _CLAUSE_BREAKS:
                continue
            end = i + 1
            if end >= len(buffer) or not buffer[end].isspace():
                continue
            while end < len(buffer) and buffer[end].isspace():
                end += 1
            if end >= len(buffer):
                return None
            if self.min_chars <= end <= self.first_chunk_max_chars:
                return end
        return None

    @staticmethod
    def _is_decimal_point(buffer: str, i: int) -> bool:
        return i > 0 and buffer[i - 1].isdigit() and i + 1 < len(buffer) and buffer[i + 1].isdigit()

    def _word_boundary_before(self, limit: int) -> int:
        cut = self._buffer.rfind(" ", self.min_chars, limit)
        return cut + 1 if cut != -1 else limit
