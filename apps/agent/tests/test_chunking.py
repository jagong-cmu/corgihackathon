"""Sentence chunking for streaming TTS.

The contiguity invariant is the important one: chunks must reassemble to
exactly the fed text. A single swallowed space shifts every cue after it.
"""

from __future__ import annotations

import pytest

from tutor_agent.core.chunking import SentenceChunker


def _feed_all(text: str, *, delta: int = 7, **kwargs) -> tuple[list[str], str]:
    """Stream `text` in fixed-size deltas, like a real token stream."""
    chunker = SentenceChunker(**kwargs)
    chunks: list[str] = []
    for i in range(0, len(text), delta):
        chunks.extend(chunker.feed(text[i : i + delta]))
    return chunks, chunker.flush()


class TestContiguity:
    """Everything fed comes back out, in order, unmodified."""

    @pytest.mark.parametrize(
        "text",
        [
            "Okay, so look at this. That term flips the sign. Got it?",
            "One sentence with no terminator",
            "Short. Bits. Here. Are. Many.",
            "Numbers like 3.5 and 0.25 must not split mid-decimal.",
            'She said "stop that." Then left.',
            "Trailing whitespace matters.   ",
            "",
            "...",
            "Multiple!!! Terminators??? Together.",
        ],
    )
    @pytest.mark.parametrize("delta", [1, 3, 7, 1000])
    def test_chunks_reassemble_exactly(self, text: str, delta: int):
        chunks, tail = _feed_all(text, delta=delta)
        assert "".join(chunks) + tail == text

    def test_no_chunk_is_empty(self):
        chunks, _ = _feed_all("A. B. C. Longer sentence here to pass the minimum.")
        assert all(chunks)


class TestSplitting:
    def test_splits_on_sentence_end(self):
        chunks, tail = _feed_all("This is the first sentence. This is the second one.", delta=1000)
        assert chunks == ["This is the first sentence. "]
        assert tail == "This is the second one."

    def test_does_not_split_inside_a_decimal(self):
        chunks, tail = _feed_all("The answer is 3.5 exactly.", delta=1000)
        assert chunks == []
        assert tail == "The answer is 3.5 exactly."

    def test_splits_after_closing_quote(self):
        chunks, _ = _feed_all('He said "go now." Then we left the room.', delta=1000)
        assert chunks == ['He said "go now." ']

    def test_short_fragment_is_held_back(self):
        """'Mm.' alone isn't worth a TTS request."""
        chunks, tail = _feed_all("Mm. Okay so here's the actual explanation.", delta=1000)
        assert chunks == []
        assert tail.startswith("Mm.")

    def test_long_run_without_punctuation_is_force_flushed(self):
        text = "word " * 100
        chunks, _ = _feed_all(text, max_chars=80)
        assert chunks, "a model that never punctuates must not stall audio forever"
        assert all(len(c) <= 80 for c in chunks)

    def test_force_flush_lands_on_a_word_boundary(self):
        chunks, _ = _feed_all("word " * 100, max_chars=80)
        assert all(c.endswith(" ") for c in chunks)


class TestIncremental:
    def test_sentence_emitted_as_soon_as_it_completes(self):
        """The whole point: don't wait for the turn to finish."""
        chunker = SentenceChunker()
        assert chunker.feed("This is a complete sentence") == []
        emitted = chunker.feed(". And more text follows here.")
        assert emitted == ["This is a complete sentence. "]

    def test_terminator_at_buffer_end_waits_for_confirmation(self):
        """A trailing '.' might be a decimal point once the next delta lands."""
        chunker = SentenceChunker()
        assert chunker.feed("The value is 3") == []
        assert chunker.feed(".") == []
        assert chunker.feed("5 and that's final.") == []

    def test_pending_exposes_the_buffer(self):
        chunker = SentenceChunker()
        chunker.feed("partial text")
        assert chunker.pending == "partial text"
        assert chunker.flush() == "partial text"
        assert chunker.pending == ""


class TestFastFirstChunk:
    """Time-to-first-audio is the number the budget measures, so the opening
    chunk breaks at a clause rather than waiting for the full stop."""

    OPENER = "Okay, so — this one factors into two binomials, and the trick is finding two numbers."

    def test_first_chunk_breaks_at_a_clause(self):
        chunks, _ = _feed_all(self.OPENER, delta=1000)
        assert chunks
        assert len(chunks[0]) <= 60
        assert chunks[0].startswith("Okay,")

    def test_later_chunks_do_not_clause_split(self):
        """Clause-splitting throughout would chop prosody up all turn."""
        text = "First one is done. Then, after that, a long second sentence continues on."
        chunks, tail = _feed_all(text, delta=1000)
        # Everything after the opening chunk breaks only on sentence ends.
        for chunk in chunks[1:]:
            assert chunk.rstrip()[-1] in ".!?"

    def test_contiguity_still_holds_with_clause_splitting(self):
        chunks, tail = _feed_all(self.OPENER, delta=3)
        assert "".join(chunks) + tail == self.OPENER

    def test_no_clause_break_falls_back_to_sentence_end(self):
        text = "A perfectly ordinary sentence without any clause breaks at all. Next one."
        chunks, _ = _feed_all(text, delta=1000)
        assert chunks[0].rstrip().endswith(".")

    def test_clause_break_beyond_the_cap_is_ignored(self):
        text = "This opening runs well past the sixty character cap before it reaches, a comma."
        chunks, tail = _feed_all(text, delta=1000)
        assert all(not c.rstrip().endswith(",") for c in chunks)
