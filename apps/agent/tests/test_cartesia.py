"""Cartesia word timestamps -> our character model.

Cartesia gives word granularity where ElevenLabs gives per-character. That is
fine — TurnTimeline snaps every cue to a word start — but only if the words are
placed at exactly the right character offsets. This is the file that proves it.
"""

from __future__ import annotations

import pytest

from tutor_agent.core.cue import TurnTimeline, synthetic_timings
from tutor_agent.providers.cartesia import (
    AlignmentMismatchError,
    word_timestamps_to_characters,
)


def _words(text: str, per_word_ms: int = 400):
    """Evenly spaced word timings over `text`, in seconds, as Cartesia returns."""
    words = text.split()
    starts = [i * per_word_ms / 1000 for i in range(len(words))]
    ends = [(i + 1) * per_word_ms / 1000 for i in range(len(words))]
    return words, starts, ends


class TestShape:
    def test_output_covers_every_character(self):
        text = "Okay, so look at this."
        timings = word_timestamps_to_characters(text, *_words(text))
        assert timings.characters == text
        assert len(timings.start_ms) == len(text)
        assert len(timings.end_ms) == len(text)

    def test_times_are_monotonic(self):
        text = "One two three four five six seven."
        timings = word_timestamps_to_characters(text, *_words(text))
        assert timings.start_ms == sorted(timings.start_ms)

    def test_empty_text(self):
        timings = word_timestamps_to_characters("", [], [], [])
        assert timings.characters == ""
        assert timings.duration_ms == 0

    def test_no_timings_degrades_to_zero_rather_than_raising(self):
        """Losing alignment costs cue anchoring, not the lesson."""
        text = "Some speech with no timings."
        timings = word_timestamps_to_characters(text, [], [], [])
        assert timings.characters == text
        assert set(timings.start_ms) == {0}


class TestWordPlacement:
    """The only values the cue engine reads are word-start times."""

    def test_word_starts_land_on_the_right_character(self):
        text = "Alpha bravo charlie."
        words, starts, ends = _words(text)
        timings = word_timestamps_to_characters(text, words, starts, ends)

        assert timings.start_ms[text.index("Alpha")] == 0
        assert timings.start_ms[text.index("bravo")] == 400
        assert timings.start_ms[text.index("charlie")] == 800

    def test_punctuation_between_words_holds_the_previous_end(self):
        text = "Yes. No."
        timings = word_timestamps_to_characters(text, ["Yes", "No"], [0.0, 1.0], [0.5, 1.5])
        # The space and period after "Yes" should not jump ahead to "No".
        assert timings.start_ms[text.index(" ")] == 500

    def test_matching_is_case_insensitive(self):
        text = "Okay So Look"
        timings = word_timestamps_to_characters(
            text, ["okay", "so", "look"], [0.0, 0.4, 0.8], [0.4, 0.8, 1.2]
        )
        assert timings.start_ms[text.index("So")] == 400

    def test_repeated_words_are_placed_in_order(self):
        """A naive `find` from zero would put both hits on the first occurrence."""
        text = "the cat and the dog"
        words, starts, ends = _words(text)
        timings = word_timestamps_to_characters(text, words, starts, ends)
        second_the = text.index("the", 8)
        assert timings.start_ms[second_the] == 3 * 400

    def test_unlocatable_word_raises_rather_than_misaligning(self):
        """A word we can't place would shift every span after it. Shifted cues
        are worse than no cues, because they look like a rendering bug."""
        with pytest.raises(AlignmentMismatchError, match="use_normalized_timestamps"):
            word_timestamps_to_characters(
                "Hello there", ["Hello", "friend"], [0.0, 0.5], [0.5, 1.0]
            )


class TestAgainstTheCueEngine:
    """The conversion has to satisfy TurnTimeline, not just look reasonable."""

    def test_timeline_accepts_the_converted_timings(self):
        text = "Okay, watch this. Both arrows appear at once."
        timeline = TurnTimeline("t_0001")
        timeline.add_text("Okay, watch this. ")
        timeline.add_action({"type": "point_at", "target": "s1"})
        timeline.add_text("Both arrows appear at once.")
        timeline.attach_timings(word_timestamps_to_characters(text, *_words(text)))

        (action,) = timeline.resolve()
        # Anchors forward onto "Both", the 4th word -> 3 * 400ms.
        assert action.cue_ms == 1200

    def test_word_granularity_matches_character_granularity_at_word_starts(self):
        """Word timestamps lose nothing the cue engine uses.

        Compared against synthetic per-character timings at the same rate: the
        engine only ever reads word-start values, so the two agree there.
        """
        text = "Alpha bravo charlie delta."
        words = text.split()
        # Make the word timings agree with the character model at word starts.
        char_timings = synthetic_timings(text)
        starts = [char_timings.start_ms[text.index(w)] / 1000 for w in words]
        ends = [s + 0.3 for s in starts]

        converted = word_timestamps_to_characters(text, words, starts, ends)
        for word in words:
            i = text.index(word)
            assert converted.start_ms[i] == char_timings.start_ms[i]


class TestFactory:
    def test_unknown_provider_is_named(self):
        from tutor_agent.persona import PersonaSpec
        from tutor_agent.providers.factory import VoiceProviderError, make_tts

        persona = PersonaSpec.model_validate(
            {
                "id": "xx",
                "kind": "synthetic",
                "identity": {"name": "X", "relationship": "a tutor"},
                "voice": {"provider": "nope", "voice_id": "v"},
            }
        )
        with pytest.raises(VoiceProviderError, match="nope"):
            make_tts(persona)

    def test_missing_key_says_which_one(self, monkeypatch):
        from tutor_agent.persona import PersonaSpec
        from tutor_agent.providers.factory import VoiceProviderError, make_tts

        monkeypatch.delenv("CARTESIA_API_KEY", raising=False)
        persona = PersonaSpec.model_validate(
            {
                "id": "xx",
                "kind": "synthetic",
                "identity": {"name": "X", "relationship": "a tutor"},
                "voice": {"provider": "cartesia", "voice_id": "v"},
            }
        )
        with pytest.raises(VoiceProviderError, match="CARTESIA_API_KEY"):
            make_tts(persona)

    def test_elevenlabs_model_name_is_not_sent_to_cartesia(self, monkeypatch):
        """VoiceConfig.model defaults to an ElevenLabs model. A persona that
        switched provider without updating it must not send that string."""
        from tutor_agent.providers.factory import _looks_like_cartesia

        assert not _looks_like_cartesia("eleven_flash_v2_5")
        assert _looks_like_cartesia("sonic-3")
