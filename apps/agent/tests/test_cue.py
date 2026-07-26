"""Cue timing. The product's whole 'synchronized to the word' claim lives here."""

from __future__ import annotations

import pytest

from tutor_agent.core.cue import (
    CharacterTimings,
    CueQueue,
    TurnTimeline,
    synthetic_timings,
)


def test_synthetic_timings_align_to_text_length():
    t = synthetic_timings("hello world")
    assert len(t.start_ms) == len("hello world")
    assert len(t.end_ms) == len("hello world")
    assert t.start_ms[0] == 0
    assert t.duration_ms > 0


def test_timings_reject_mismatched_arrays():
    with pytest.raises(ValueError, match="must match text length"):
        CharacterTimings(characters="abc", start_ms=[0, 1], end_ms=[1, 2])


def test_empty_text_produces_empty_timings():
    t = synthetic_timings("")
    assert t.duration_ms == 0
    assert t.characters == ""


class TestAnchoring:
    """The action fires on the words AFTER it, not the words before."""

    def test_action_anchors_to_following_word(self):
        timeline = TurnTimeline("t_0001")
        timeline.add_text("Okay so look at this. ")
        timeline.add_action({"type": "highlight", "target": "eq_1"})
        timeline.add_text("That term flips the sign.")
        timeline.attach_timings(synthetic_timings(timeline.speech_text))

        (action,) = timeline.resolve()

        # Should fire at "That", not at the end of "this. "
        text = timeline.speech_text
        expected_index = text.index("That term")
        expected_ms = timeline._segments[0].start_ms[expected_index]
        assert action.cue_ms == expected_ms

    def test_anchor_skips_whitespace_and_punctuation(self):
        timeline = TurnTimeline("t_0001")
        timeline.add_text("Watch. ")
        timeline.add_action({"type": "point_at", "target": "s1"})
        timeline.add_text("   ...Here!")
        timeline.attach_timings(synthetic_timings(timeline.speech_text))

        (action,) = timeline.resolve()
        text = timeline.speech_text
        # Lands on the H of "Here", not on a space, dot, or exclamation.
        assert text[_index_at_ms(timeline, action.cue_ms)] == "H"

    def test_action_at_start_fires_at_zero(self):
        timeline = TurnTimeline("t_0001")
        timeline.add_action({"type": "new_section", "title": "Part 2"})
        timeline.add_text("Alright, new topic.")
        timeline.attach_timings(synthetic_timings(timeline.speech_text))

        (action,) = timeline.resolve()
        assert action.cue_ms == 0

    def test_present_visual_anchors_to_turn_start_not_narration(self):
        # The model calls present_visual after its opening words, but the
        # board must mount immediately: a cue held for the narration to reach
        # it dies pending on the first barge-in, and the learner watches the
        # tutor talk at a blank whiteboard.
        timeline = TurnTimeline("t_0001")
        timeline.add_text("Alright, let's look at the Pythagorean theorem. ")
        timeline.add_action({"type": "present_visual", "spec": {"specVersion": 1}})
        timeline.add_text("First, here's the triangle.")
        timeline.add_action({"type": "reveal_step", "stepId": "triangle"})
        timeline.attach_timings(synthetic_timings(timeline.speech_text))

        present, reveal = timeline.resolve()
        assert present.action["type"] == "present_visual"
        assert present.cue_ms == 0
        # reveal_step keeps its narration anchor.
        assert reveal.cue_ms > 0

    def test_only_the_first_present_visual_anchors_to_turn_start(self):
        # A replacement board mid-turn anchored at 0 would sort BEFORE the
        # first board's reveals in resolve() and fire instantly on the live
        # path, clobbering the board the narration still points at.
        timeline = TurnTimeline("t_0001")
        timeline.add_text("Here's the first board. ")
        timeline.add_action({"type": "present_visual", "spec": {"specVersion": 1}})
        timeline.add_text("Now watch this step. ")
        timeline.add_action({"type": "reveal_step", "stepId": "s1"})
        timeline.add_text("Actually, let's start over with a cleaner picture. ")
        timeline.add_action({"type": "present_visual", "spec": {"specVersion": 1}})
        timeline.attach_timings(synthetic_timings(timeline.speech_text))

        first, reveal, second = timeline.resolve()
        assert first.action["type"] == "present_visual" and first.cue_ms == 0
        assert reveal.action["type"] == "reveal_step"
        # The replacement anchors to its narration, AFTER the reveal.
        assert second.action["type"] == "present_visual"
        assert second.cue_ms >= reveal.cue_ms

    def test_present_visual_emits_with_first_synthesized_segment(self):
        # Sentence-at-a-time synthesis: the board frame must go out with the
        # first segment, not wait for its narration anchor to be covered.
        timeline = TurnTimeline("t_0001")
        timeline.add_text("Okay, here's the idea. ")
        timeline.add_action({"type": "present_visual", "spec": {"specVersion": 1}})
        timeline.attach_timings(synthetic_timings("Okay, here's the idea. "))

        ready = timeline.resolve_ready()
        assert [a.action["type"] for a in ready] == ["present_visual"]
        assert ready[0].cue_ms == 0

    def test_action_past_end_of_speech_fires_at_end_not_dropped(self):
        timeline = TurnTimeline("t_0001")
        timeline.add_text("Done.")
        timeline.add_action({"type": "camera", "op": "focus", "target": "s1"})
        timeline.attach_timings(synthetic_timings(timeline.speech_text))

        actions = timeline.resolve()
        # A late action is recoverable; a missing one is not.
        assert len(actions) == 1
        assert actions[0].cue_ms == timeline.total_duration_ms


class TestSegments:
    """Timestamps are per-segment; a turn's later segments need an offset."""

    def test_second_segment_times_are_offset_by_the_first(self):
        first = "First part. "
        second = "Second part."

        timeline = TurnTimeline("t_0001")
        timeline.add_text(first)
        timeline.add_text(second)
        timeline.add_action({"type": "point_at", "target": "s1"})

        t1 = synthetic_timings(first)
        t2 = synthetic_timings(second)
        timeline.attach_timings(t1)
        timeline.attach_timings(t2)

        assert timeline.total_duration_ms == t1.duration_ms + t2.duration_ms

    def test_action_in_second_segment_gets_absolute_time(self):
        first = "Here is the setup. "
        second = "Now watch the collision."

        timeline = TurnTimeline("t_0001")
        timeline.add_text(first)
        timeline.add_action({"type": "sim_control", "id": "sim_a", "op": "play"})
        timeline.add_text(second)

        t1 = synthetic_timings(first)
        t2 = synthetic_timings(second)
        timeline.attach_timings(t1)
        timeline.attach_timings(t2)

        (action,) = timeline.resolve()
        # "Now" starts the second segment, so the cue must be at least the
        # whole first segment's duration — the bug this guards against is
        # returning a time relative to segment 2's own zero.
        assert action.cue_ms >= t1.duration_ms


class TestOrdering:
    def test_seq_is_assigned_in_stream_order(self):
        timeline = TurnTimeline("t_0001")
        timeline.add_action({"type": "new_section", "title": "A"})
        timeline.add_text("one ")
        timeline.add_action({"type": "point_at", "target": "s1"})
        timeline.add_text("two ")
        timeline.add_action({"type": "point_at", "target": "s2"})
        timeline.add_text("three")
        timeline.attach_timings(synthetic_timings(timeline.speech_text))

        actions = timeline.resolve()
        assert [a.seq for a in actions] == [0, 1, 2]

    def test_cue_ms_is_non_decreasing(self):
        timeline = TurnTimeline("t_0001")
        for i in range(5):
            timeline.add_action({"type": "point_at", "target": f"s{i}"})
            timeline.add_text(f"word{i} and some more text here. ")
        timeline.attach_timings(synthetic_timings(timeline.speech_text))

        cues = [a.cue_ms for a in timeline.resolve()]
        assert cues == sorted(cues)

    def test_ties_break_by_seq(self):
        """Two actions anchored to the same word keep their emission order."""
        timeline = TurnTimeline("t_0001")
        timeline.add_action({"type": "new_section", "title": "A"})
        timeline.add_action({"type": "camera", "op": "focus", "target": "s1"})
        timeline.add_text("Both of these fire together.")
        timeline.attach_timings(synthetic_timings(timeline.speech_text))

        actions = timeline.resolve()
        assert actions[0].cue_ms == actions[1].cue_ms
        assert [a.seq for a in actions] == [0, 1]


class TestNoAudio:
    """Text channels have no timings — everything fires immediately."""

    def test_all_actions_fire_at_zero_without_timings(self):
        timeline = TurnTimeline("t_0001")
        timeline.add_text("Some text. ")
        timeline.add_action({"type": "point_at", "target": "s1"})
        timeline.add_text("More text.")
        timeline.add_action({"type": "point_at", "target": "s2"})

        actions = timeline.resolve()
        assert [a.cue_ms for a in actions] == [0, 0]
        assert [a.seq for a in actions] == [0, 1]


class TestLead:
    def test_lead_ms_pulls_cues_earlier(self):
        def build(lead: int) -> int:
            timeline = TurnTimeline("t_0001", lead_ms=lead)
            timeline.add_text("A fairly long run of words before the action. ")
            timeline.add_action({"type": "point_at", "target": "s1"})
            timeline.add_text("Now.")
            timeline.attach_timings(synthetic_timings(timeline.speech_text))
            return timeline.resolve()[0].cue_ms

        assert build(100) == build(0) - 100

    def test_lead_never_goes_negative(self):
        timeline = TurnTimeline("t_0001", lead_ms=5000)
        timeline.add_action({"type": "new_section", "title": "A"})
        timeline.add_text("Short.")
        timeline.attach_timings(synthetic_timings(timeline.speech_text))
        assert timeline.resolve()[0].cue_ms == 0


class TestCueQueue:
    def test_new_turn_supersedes_previous(self):
        q = CueQueue()
        assert q.begin_turn("t_0001") is None
        assert q.begin_turn("t_0002") == "t_0001"
        assert not q.should_emit("t_0001")
        assert q.should_emit("t_0002")

    def test_explicit_cancel(self):
        q = CueQueue()
        q.begin_turn("t_0001")
        q.cancel("t_0001")
        assert not q.should_emit("t_0001")
        assert q.active_turn_id is None

    def test_rebeginning_same_turn_is_not_a_supersede(self):
        q = CueQueue()
        q.begin_turn("t_0001")
        assert q.begin_turn("t_0001") == "t_0001"
        assert q.should_emit("t_0001")


def _index_at_ms(timeline: TurnTimeline, ms: int) -> int:
    """Reverse-map a time back to a character index, for assertions."""
    segment = timeline._segments[0]
    for i, start in enumerate(segment.start_ms):
        if start >= ms:
            return i
    return len(segment.characters) - 1


class TestIncrementalResolution:
    """Actions emit as soon as their anchor segment is synthesized.

    Without this, audio starts immediately but the actions for its first words
    arrive after the whole turn finishes — by then the cue is in the past.
    """

    def _timeline(self) -> TurnTimeline:
        timeline = TurnTimeline("t_0001")
        timeline.add_text("First sentence here. ")
        timeline.add_action({"type": "point_at", "target": "s1"})
        timeline.add_text("Second sentence here. ")
        timeline.add_action({"type": "point_at", "target": "s2"})
        timeline.add_text("Third sentence here.")
        return timeline

    def test_nothing_ready_before_any_synthesis(self):
        assert self._timeline().resolve_ready() == []

    def test_action_becomes_ready_once_its_anchor_is_covered(self):
        timeline = self._timeline()
        timeline.attach_timings(synthetic_timings("First sentence here. "))
        # s1 anchors at the start of sentence two, which isn't synthesized yet.
        assert timeline.resolve_ready() == []

        timeline.attach_timings(synthetic_timings("Second sentence here. "))
        ready = timeline.resolve_ready()
        assert [a.action["target"] for a in ready] == ["s1"]

    def test_each_action_emits_exactly_once(self):
        timeline = self._timeline()
        timeline.attach_timings(synthetic_timings("First sentence here. "))
        timeline.attach_timings(synthetic_timings("Second sentence here. "))
        first = timeline.resolve_ready()
        assert first
        assert timeline.resolve_ready() == []

    def test_resolve_remaining_catches_actions_past_end_of_speech(self):
        timeline = self._timeline()
        for part in ("First sentence here. ", "Second sentence here. ", "Third sentence here."):
            timeline.attach_timings(synthetic_timings(part))
        ready = timeline.resolve_ready()
        remaining = timeline.resolve_remaining()

        seqs = sorted(a.seq for a in [*ready, *remaining])
        assert seqs == [0, 1], "every action must come out exactly once across both calls"

    def test_incremental_and_batch_agree_on_timing(self):
        """resolve_ready must produce the same cueMs resolve() would."""
        batch = self._timeline()
        incremental = self._timeline()
        parts = ["First sentence here. ", "Second sentence here. ", "Third sentence here."]

        for part in parts:
            batch.attach_timings(synthetic_timings(part))

        collected = []
        for part in parts:
            incremental.attach_timings(synthetic_timings(part))
            collected.extend(incremental.resolve_ready())
        collected.extend(incremental.resolve_remaining())

        assert {(a.seq, a.cue_ms) for a in collected} == {
            (a.seq, a.cue_ms) for a in batch.resolve()
        }
