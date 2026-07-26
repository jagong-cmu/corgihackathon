"""Inline reveal markers. The no-round-trip narration contract lives here."""

from __future__ import annotations

import pytest

from tutor_agent.core.markers import RevealMarker, RevealMarkerScanner


def collect(pieces):
    """(speech, markers) from a scanner output list."""
    speech = "".join(p for p in pieces if isinstance(p, str))
    markers = [p.step_id for p in pieces if isinstance(p, RevealMarker)]
    return speech, markers


class TestOneShot:
    def test_plain_text_passes_through(self):
        s = RevealMarkerScanner()
        speech, markers = collect(s.feed("Just talking, no board."))
        assert speech == "Just talking, no board."
        assert markers == []

    def test_marker_is_stripped_and_reported(self):
        s = RevealMarkerScanner()
        speech, markers = collect(s.feed("[[reveal:axes]] Here are our axes."))
        assert speech == " Here are our axes."
        assert markers == ["axes"]

    def test_multiple_markers_in_one_chunk(self):
        s = RevealMarkerScanner()
        pieces = s.feed("[[reveal:a]] one. [[reveal:b]] two. [[reveal:c]] three.")
        speech, markers = collect(pieces)
        assert markers == ["a", "b", "c"]
        assert speech == " one.  two.  three."

    def test_marker_preserves_surrounding_order(self):
        s = RevealMarkerScanner()
        pieces = s.feed("before [[reveal:mid]] after")
        assert pieces == ["before ", RevealMarker("mid"), " after"]

    def test_literal_double_bracket_prose_is_released(self):
        s = RevealMarkerScanner()
        speech, markers = collect(s.feed("matrix [[1, 2], [3, 4]] done"))
        assert markers == []
        assert speech == "matrix [[1, 2], [3, 4]] done"

    def test_wrong_keyword_is_prose(self):
        s = RevealMarkerScanner()
        speech, markers = collect(s.feed("[[highlight:x]] nope"))
        assert markers == []
        assert speech == "[[highlight:x]] nope"

    def test_empty_step_id_is_prose(self):
        s = RevealMarkerScanner()
        speech, markers = collect(s.feed("[[reveal:]] nothing"))
        assert markers == []
        assert speech == "[[reveal:]] nothing"


class TestStreaming:
    @pytest.mark.parametrize("split", range(1, len("[[reveal:axes]]")))
    def test_marker_split_at_every_boundary(self, split):
        text = "go [[reveal:axes]] now"
        marker_start = text.index("[[")
        cut = marker_start + split
        s = RevealMarkerScanner()
        pieces = s.feed(text[:cut]) + s.feed(text[cut:])
        speech, markers = collect(pieces)
        assert markers == ["axes"]
        assert speech == "go  now"

    def test_marker_split_across_many_tiny_deltas(self):
        s = RevealMarkerScanner()
        pieces = []
        for ch in "a [[reveal:step-1]] b":
            pieces += s.feed(ch)
        speech, markers = collect(pieces)
        assert markers == ["step-1"]
        assert speech == "a  b"

    def test_speech_is_not_held_hostage_by_false_prefix(self):
        # "[[re" then a chunk that disproves the marker: everything releases.
        s = RevealMarkerScanner()
        pieces = s.feed("say [[re")
        assert "say " in "".join(p for p in pieces if isinstance(p, str))
        pieces += s.feed("d carpet]] end")
        speech, markers = collect(pieces)
        assert markers == []
        assert speech == "say [[red carpet]] end"

    def test_flush_returns_lone_bracket_as_prose(self):
        s = RevealMarkerScanner()
        s.feed("count [")
        text, dropped = s.flush()
        assert text == "["
        assert dropped == ""

    def test_flush_drops_incomplete_marker(self):
        s = RevealMarkerScanner()
        s.feed("go [[reveal:ax")
        text, dropped = s.flush()
        assert text == ""
        assert dropped == "[[reveal:ax"

    def test_scanner_reusable_after_flush(self):
        s = RevealMarkerScanner()
        s.feed("x [[reveal:a")
        s.flush()
        speech, markers = collect(s.feed("[[reveal:b]] y"))
        assert markers == ["b"]
        assert speech == " y"
