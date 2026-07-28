"""Turn-taking gate: acknowledgments must not kill the tutor's reply.

The failure this guards against is real, not hypothetical: a 2026-07-27
session recorded 181 of 279 turns cancelled, almost all by backchannel
("Set.", "No problem.", "Thank you. Okay.") firing the onset-barge path.
Every case string in TestIsBackchannel's acknowledgment list that appears in
quotes in core/turntaking.py's docstring came from that session's log.
"""

from __future__ import annotations

import pytest

from tutor_agent.core.turntaking import UtteranceGate, is_backchannel


class TestIsBackchannel:
    @pytest.mark.parametrize(
        "text",
        [
            "Okay.",
            "okay",
            "Thank you. Okay.",
            "No problem.",
            "yeah yeah",
            "Mm-hmm.",
            "Got it!",
            "oh okay cool",
            "Right.",
            "Makes sense.",
            "Uh-huh.",
            "Thanks!",
            "All right.",
            "Wow, nice.",
        ],
    )
    def test_acknowledgments(self, text: str) -> None:
        assert is_backchannel(text)

    @pytest.mark.parametrize(
        "text",
        [
            # "no" alone is a correction, not an ack — only "no problem" /
            # "no worries" pass, via the phrase list.
            "No.",
            "Set.",
            "Can you explain?",
            "Okay, but why?",
            "Wait.",
            "Stop.",
            "Yes and no.",
            "I see a problem.",
            "",
            "   ",
        ],
    )
    def test_substantive(self, text: str) -> None:
        assert not is_backchannel(text)


class TestUtteranceGate:
    def test_substantive_interim_interrupts_exactly_once(self) -> None:
        gate = UtteranceGate()
        gate.start()
        assert not gate.heard("okay")
        assert gate.heard("okay so about the")
        # Later interims of the same utterance must not re-fire.
        assert not gate.heard("okay so about the second step")

    def test_backchannel_interims_hold_the_floor(self) -> None:
        # Partials are cumulative: "thank" arrives alone before "thank you".
        # The cut-off phrase opener must not commit the interrupt.
        gate = UtteranceGate()
        gate.start()
        assert not gate.heard("thank")
        assert not gate.heard("thank you")
        assert not gate.heard("thank you okay")
        # ...and the final is then dropped while the tutor is busy.
        assert gate.finish("Thank you. Okay.", tutor_busy=True)

    def test_phrase_opener_grace_is_one_word_only(self) -> None:
        # "no" could still become "no problem" — hold. "no that's" cannot —
        # a correction must interrupt on the very next partial.
        gate = UtteranceGate()
        gate.start()
        assert not gate.heard("no")
        assert gate.heard("no that's wrong")

    def test_deadline_fires_only_without_interim_evidence(self) -> None:
        gate = UtteranceGate()
        gate.start()
        assert gate.deadline_passed()
        # Exactly once.
        assert not gate.deadline_passed()

        gate.start()
        gate.heard("okay")
        # An interim arrived — the deadline defers to transcript evidence.
        assert not gate.deadline_passed()

    def test_deadline_is_inert_after_finish(self) -> None:
        gate = UtteranceGate()
        gate.start()
        assert not gate.finish("Okay.", tutor_busy=False)
        # The timer losing the race to the final must not interrupt the
        # NEXT reply.
        assert not gate.deadline_passed()

    def test_ack_final_is_a_turn_when_tutor_is_idle(self) -> None:
        # "Yes." answering a question the tutor already finished asking.
        gate = UtteranceGate()
        gate.start()
        assert not gate.finish("Yes.", tutor_busy=False)

    def test_ack_final_becomes_a_turn_if_we_already_interrupted(self) -> None:
        # The reply is already dead — answering beats leaving silence.
        gate = UtteranceGate()
        gate.start()
        assert gate.deadline_passed()
        assert not gate.finish("Okay.", tutor_busy=True)

    def test_substantive_final_is_always_a_turn(self) -> None:
        gate = UtteranceGate()
        gate.start()
        assert not gate.finish("Can you explain that again?", tutor_busy=True)

    def test_state_resets_between_utterances(self) -> None:
        gate = UtteranceGate()
        gate.start()
        gate.heard("so the thing is")
        assert not gate.finish("So the thing is, why?", tutor_busy=True)

        gate.start()
        # Fresh utterance: earlier substantive interims must not leak in.
        assert not gate.heard("okay")
        assert gate.finish("Okay.", tutor_busy=True)
