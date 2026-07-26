"""Cue timing: turn a tool call's position in the text stream into a cueMs.

## The mechanism

Claude streams one interleaved response containing text blocks and tool_use
blocks in order. As we consume the stream we record, for each tool call, how
many characters of *speech text* had accumulated when that call opened. That
character offset is the anchor.

ElevenLabs returns character-level timestamps aligned to the exact text we sent
it. So the anchor maps to a time almost directly — the work is in three details
that are easy to get wrong:

1. **Anchor forward, not backward.** The model is prompted to emit an action
   immediately BEFORE the words it accompanies (see VOICE_AND_CANVAS_RULES), so
   the cue belongs on the first word *after* the offset, not the last word
   before it. Anchoring backward fires every action a beat late.

2. **Snap to word boundaries.** Firing mid-word reads as a glitch. We snap to
   the start of the next word.

3. **Segments accumulate.** Speech is synthesized per segment, so each segment's
   timestamps are relative to its own start. A turn's second segment needs the
   first segment's duration added.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class CharacterTimings:
    """Character-level timings for one synthesized segment.

    Mirrors the ElevenLabs `alignment` object, which aligns to the *original*
    input text (not the normalized text — that's `normalized_alignment`, and
    using it here would desync every cue).
    """

    characters: str
    """The exact text these timings describe."""

    start_ms: list[int]
    """start_ms[i] is when characters[i] begins, relative to this segment."""

    end_ms: list[int]
    """end_ms[i] is when characters[i] finishes, relative to this segment."""

    def __post_init__(self) -> None:
        n = len(self.characters)
        if len(self.start_ms) != n or len(self.end_ms) != n:
            raise ValueError(
                f"timing arrays must match text length: {n} chars, "
                f"{len(self.start_ms)} starts, {len(self.end_ms)} ends"
            )

    @property
    def duration_ms(self) -> int:
        return self.end_ms[-1] if self.end_ms else 0


@dataclass(frozen=True)
class PendingAction:
    """A canvas action captured mid-stream, not yet assigned a time."""

    action: dict
    char_offset: int
    """Characters of speech text accumulated when this tool call opened."""

    seq: int


@dataclass(frozen=True)
class TimedAction:
    """A canvas action with its firing time resolved."""

    action: dict
    seq: int
    cue_ms: int


# Characters that never start a word. Anchoring onto one of these would fire the
# cue on a space or a comma instead of the word the learner actually hears.
_NON_WORD = set(" \t\n\r.,;:!?—–-\"'()[]{}")


def _next_word_start(text: str, offset: int) -> int:
    """Index of the first word-initial character at or after `offset`."""
    i = max(0, min(offset, len(text)))
    while i < len(text) and text[i] in _NON_WORD:
        i += 1
    return i


class TurnTimeline:
    """Accumulates speech segments and pending actions for a single turn.

    Usage during a streamed turn:

        timeline = TurnTimeline(turn_id="t_0042")
        timeline.add_text("Okay, watch this. ")
        timeline.add_action({"type": "sim_control", ...})   # anchors here
        timeline.add_text("Both arrows appear at once.")
        timeline.attach_timings(segment_timings)
        for timed in timeline.resolve():
            channel.send(timed)
    """

    def __init__(self, turn_id: str, lead_ms: int = 0) -> None:
        self.turn_id = turn_id
        self.lead_ms = lead_ms
        """Fire actions this many ms early, to hide client render latency.
        Default 0 — measure real end-to-end latency before dialing this in,
        because guessing here produces visible desync in the other direction."""

        self._text_parts: list[str] = []
        self._char_count = 0
        self._pending: list[PendingAction] = []
        self._segments: list[CharacterTimings] = []
        self._next_seq = 0
        self._emitted: set[int] = set()

    # -- stream consumption -------------------------------------------------

    def add_text(self, chunk: str) -> None:
        self._text_parts.append(chunk)
        self._char_count += len(chunk)

    def add_action(self, action: dict) -> PendingAction:
        """Anchor an action at the current position in the text stream."""
        pending = PendingAction(action=action, char_offset=self._char_count, seq=self._next_seq)
        self._next_seq += 1
        self._pending.append(pending)
        return pending

    def attach_timings(self, timings: CharacterTimings) -> None:
        """Attach timings for the next speech segment, in synthesis order."""
        self._segments.append(timings)

    # -- resolution ---------------------------------------------------------

    @property
    def speech_text(self) -> str:
        return "".join(self._text_parts)

    @property
    def total_duration_ms(self) -> int:
        return sum(s.duration_ms for s in self._segments)

    def resolve(self) -> list[TimedAction]:
        """Assign a cueMs to every pending action.

        Actions anchored past the end of synthesized speech fire at the end of
        the audio rather than being dropped — a late action is recoverable, a
        missing one is not.
        """
        if not self._segments:
            # No audio (text-only channel, or TTS failed). Everything fires
            # immediately, in order. The messaging adapter relies on this path.
            return [TimedAction(p.action, p.seq, 0) for p in self._pending]

        joined = "".join(s.characters for s in self._segments)
        offsets = self._segment_offsets()

        timed: list[TimedAction] = []
        for pending in self._pending:
            anchor = _next_word_start(joined, pending.char_offset)
            cue = self._time_at(anchor, offsets)
            cue = max(0, cue - self.lead_ms)
            timed.append(TimedAction(action=pending.action, seq=pending.seq, cue_ms=cue))

        # seq order is the contract; cueMs may tie when two actions anchor to
        # the same word, and the client applies ties in seq order.
        timed.sort(key=lambda t: (t.cue_ms, t.seq))
        return timed

    @property
    def synthesized_chars(self) -> int:
        """Characters covered by timings so far."""
        return sum(len(s.characters) for s in self._segments)

    def resolve_ready(self) -> list[TimedAction]:
        """Actions whose anchor falls inside already-synthesized text.

        Called after each segment is synthesized, so an action can go out while
        the rest of the turn is still generating. Without this, audio would
        start immediately but the actions for its first words would arrive after
        the whole turn finished — the cue would already be in the past.

        Each action is returned at most once.
        """
        if not self._segments:
            return []

        joined = "".join(s.characters for s in self._segments)
        offsets = self._segment_offsets()
        ready: list[TimedAction] = []

        for pending in self._pending:
            if pending.seq in self._emitted:
                continue
            anchor = _next_word_start(joined, pending.char_offset)
            # Not yet covered — a later segment may still contain this anchor.
            if anchor >= len(joined):
                continue
            self._emitted.add(pending.seq)
            cue = max(0, self._time_at(anchor, offsets) - self.lead_ms)
            ready.append(TimedAction(action=pending.action, seq=pending.seq, cue_ms=cue))

        ready.sort(key=lambda t: (t.cue_ms, t.seq))
        return ready

    def resolve_remaining(self) -> list[TimedAction]:
        """Anything not yet emitted, once the turn is over.

        Actions anchored past the end of speech land here and fire at the end of
        the audio rather than being dropped.
        """
        remaining: list[TimedAction] = []
        for timed in self.resolve():
            if timed.seq in self._emitted:
                continue
            self._emitted.add(timed.seq)
            remaining.append(timed)
        return remaining

    def _segment_offsets(self) -> list[tuple[int, int]]:
        """(char_start, time_offset_ms) for each segment in the joined text."""
        offsets: list[tuple[int, int]] = []
        char_cursor = 0
        time_cursor = 0
        for segment in self._segments:
            offsets.append((char_cursor, time_cursor))
            char_cursor += len(segment.characters)
            time_cursor += segment.duration_ms
        return offsets

    def _time_at(self, char_index: int, offsets: list[tuple[int, int]]) -> int:
        """Absolute ms within the turn for a character index in the joined text."""
        for segment, (char_start, time_offset) in zip(self._segments, offsets, strict=True):
            local = char_index - char_start
            if 0 <= local < len(segment.characters):
                return time_offset + segment.start_ms[local]

        # Past the end of all speech: fire at the end of the audio.
        return self.total_duration_ms


def synthetic_timings(
    text: str, words_per_minute: float = 150.0, start_ms: int = 0
) -> CharacterTimings:
    """Deterministic fake timings, for tests and for running with no API keys.

    Distributes time evenly across characters at a plausible speaking rate. Not
    acoustically accurate — real speech stretches vowels and compresses
    function words — but it's deterministic, which is what tests need, and it
    exercises exactly the same code path as real ElevenLabs alignment.
    """
    if not text:
        return CharacterTimings(characters="", start_ms=[], end_ms=[])

    # ~5 characters per word including the trailing space.
    chars_per_second = (words_per_minute * 5.0) / 60.0
    ms_per_char = 1000.0 / chars_per_second

    starts: list[int] = []
    ends: list[int] = []
    for i in range(len(text)):
        starts.append(start_ms + int(i * ms_per_char))
        ends.append(start_ms + int((i + 1) * ms_per_char))
    return CharacterTimings(characters=text, start_ms=starts, end_ms=ends)


@dataclass
class CueQueue:
    """Tracks in-flight turns so barge-in can cancel unfired cues.

    §4: "a new turn's first action implicitly cancels any unfired cues from the
    previous turn". This lives agent-side as well as client-side — the client
    enforces it for cues already sent, and this stops us sending more.
    """

    active_turn_id: str | None = None
    _cancelled: set[str] = field(default_factory=set)

    def begin_turn(self, turn_id: str) -> str | None:
        """Start a new turn. Returns the turn it superseded, if any."""
        superseded = self.active_turn_id
        if superseded is not None and superseded != turn_id:
            self._cancelled.add(superseded)
        self.active_turn_id = turn_id
        return superseded

    def cancel(self, turn_id: str) -> None:
        self._cancelled.add(turn_id)
        if self.active_turn_id == turn_id:
            self.active_turn_id = None

    def is_cancelled(self, turn_id: str) -> bool:
        return turn_id in self._cancelled

    def should_emit(self, turn_id: str) -> bool:
        """False once a turn has been superseded or explicitly cancelled."""
        return not self.is_cancelled(turn_id)
