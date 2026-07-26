"""Splitting a document into retrievable chunks.

Not to be confused with `core/chunking.py`, which splits the model's *speech*
into TTS segments. Same word, opposite goals: that one optimizes for time to
first audio and wants the smallest safe fragment; this one optimizes for whether
a chunk still means something on its own once it is ripped out of its document.

Two decisions carry most of the retrieval quality here.

**Split on structure before length.** Paragraph breaks are the author telling
you where the ideas end. Cutting mid-paragraph to hit a length target produces
chunks that retrieve well and read as gibberish when `show_source` puts them on
the board in front of the learner (§5.2).

**Overlap.** A definition at a paragraph boundary otherwise belongs to neither
neighbour, and the question that needed it matches neither.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass

DEFAULT_TARGET_CHARS = 1200
"""Roughly 300 tokens. Small enough that five of them fit in a turn's context
without crowding out the persona prompt, large enough to hold a worked example."""

DEFAULT_OVERLAP_CHARS = 180
DEFAULT_MIN_CHARS = 80
"""Below this a chunk is a heading or a stray line. It still gets attached to a
neighbour rather than indexed alone, where it would match everything weakly."""

_PARAGRAPH = re.compile(r"\n\s*\n")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_WHITESPACE = re.compile(r"[ \t]+")


@dataclass(frozen=True)
class DocumentChunk:
    ix: int
    text: str


def normalize(text: str) -> str:
    """Collapse the whitespace damage that PDF and HTML extraction leaves.

    Runs of spaces become one; runs of blank lines become exactly one blank
    line, because paragraph boundaries are load-bearing below.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _WHITESPACE.sub(" ", text)
    text = re.sub(r"[ \t]*\n[ \t]*", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _split_oversized(block: str, target: int) -> Iterator[str]:
    """A single paragraph longer than the target: fall back to sentences.

    A paragraph that is still too long after that (a wall of text with no
    punctuation, common in scraped slides) is cut on length, because an
    unbounded chunk would blow the context budget.
    """
    if len(block) <= target:
        yield block
        return

    current = ""
    for sentence in _SENTENCE_END.split(block):
        if len(sentence) > target:
            if current:
                yield current
                current = ""
            for start in range(0, len(sentence), target):
                yield sentence[start : start + target]
            continue
        if not current:
            current = sentence
        elif len(current) + 1 + len(sentence) <= target:
            current = f"{current} {sentence}"
        else:
            yield current
            current = sentence
    if current:
        yield current


def chunk_document(
    text: str,
    *,
    target_chars: int = DEFAULT_TARGET_CHARS,
    overlap_chars: int = DEFAULT_OVERLAP_CHARS,
    min_chars: int = DEFAULT_MIN_CHARS,
) -> list[DocumentChunk]:
    """Split a document into overlapping, structure-respecting chunks.

    Returns [] for empty input — an empty chunk violates
    `doc_chunks_text_nonempty` and there is no point discovering that in the
    database.
    """
    if overlap_chars >= target_chars:
        raise ValueError(
            f"overlap_chars={overlap_chars} must be under target_chars={target_chars}, "
            "or chunks never advance"
        )

    normalized = normalize(text)
    if not normalized:
        return []

    # Pack paragraphs up to the target, splitting any that overflow on their own.
    packed: list[str] = []
    current = ""
    for block in _PARAGRAPH.split(normalized):
        block = block.strip()
        if not block:
            continue
        for piece in _split_oversized(block, target_chars):
            if not current:
                current = piece
            elif len(current) + 2 + len(piece) <= target_chars:
                current = f"{current}\n\n{piece}"
            else:
                packed.append(current)
                current = piece
    if current:
        packed.append(current)

    # A trailing scrap ("Chapter 4", a page number) retrieves badly alone.
    if len(packed) > 1 and len(packed[-1]) < min_chars:
        packed[-2] = f"{packed[-2]}\n\n{packed.pop()}"

    if not overlap_chars:
        return [DocumentChunk(ix=i, text=t) for i, t in enumerate(packed)]

    # Prepend the tail of the previous chunk, cut back to a word boundary so the
    # overlap doesn't open mid-word.
    out: list[DocumentChunk] = []
    for i, body in enumerate(packed):
        if i == 0:
            out.append(DocumentChunk(ix=0, text=body))
            continue
        tail = packed[i - 1][-overlap_chars:]
        space = tail.find(" ")
        if space != -1:
            tail = tail[space + 1 :]
        out.append(DocumentChunk(ix=i, text=f"{tail.strip()}\n\n{body}" if tail.strip() else body))
    return out
