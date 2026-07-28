"""Turn-taking: which learner sounds take the floor from the tutor.

Where this policy came from: a real session (2026-07-27, room
tutor-napoleon-b0565042) in which 181 of 279 recorded turns ended cancelled.
The learner wasn't cutting the tutor off — they were listening the way people
listen, with "Set.", "No problem.", "Thank you. Okay." — and every one of
those acknowledgments fired the worker's barge-in path, which killed the rest
of the reply and then became a turn of its own for the tutor to answer. The
felt symptom is the tutor "pausing mid-sentence and never finishing", which
reads as an audio bug; it is a turn-taking bug.

The old policy interrupted on START_OF_SPEECH, unconditionally, because
waiting for the final transcript means talking over the learner for the whole
VAD window. The new policy keeps that instinct for REAL interruptions but
demands evidence before yielding the floor:

  - an interim transcript that is not a pure acknowledgment -> interrupt now
  - speech that outlasts INTERRUPT_DEADLINE_S with no transcript evidence
    either way -> interrupt (Scribe skips interims on some utterances — the
    null-sttFinalizeMs edge — and a real interruption must not wait for its
    final transcript exactly when the transport is least helpful)
  - a final transcript that is a pure acknowledgment while the tutor holds
    the floor -> not a turn at all. Dropping it is the fix; answering it
    ("you're welcome...") derails the lesson twice — once for the kill,
    once for the junk reply.

Deliberately conservative: an unknown word makes the whole utterance
substantive, so the worst failure mode is the old behavior (an over-eager
interrupt), never a learner the tutor ignores.
"""

from __future__ import annotations

import re

INTERRUPT_DEADLINE_S = 0.6
"""How long an utterance may run with no interim evidence before the tutor
yields anyway. Long enough that "okay" or "got it" usually finalizes first
(VAD commits after TUTOR_VAD_MIN_SILENCE_MS of silence), short enough that a
learner saying "wait, wait —" isn't talked over for a full sentence."""

_WORDS_RE = re.compile(r"[a-z']+")

# Two-word acknowledgments matched before single words, so "no problem"
# passes without admitting "no" alone — "no" while the tutor is speaking is a
# correction and must interrupt.
_ACK_PHRASES: frozenset[tuple[str, ...]] = frozenset(
    {
        ("uh", "huh"),
        ("mm", "hmm"),
        ("no", "problem"),
        ("no", "worries"),
        ("thank", "you"),
        ("got", "it"),
        ("i", "see"),
        ("makes", "sense"),
        ("of", "course"),
        ("all", "right"),
    }
)

_ACK_WORDS: frozenset[str] = frozenset(
    {
        "ok", "okay", "kay",
        "yeah", "yep", "yes", "yea",
        "mm", "mhm", "hmm",
        "right", "sure", "cool", "nice", "wow",
        "oh", "ah", "aha", "um", "uh",
        "gotcha", "alright",
        "thanks",
        "great", "awesome", "perfect",
        "interesting", "exactly", "totally",
    }
)


_PHRASE_OPENERS: frozenset[str] = frozenset(p[0] for p in _ACK_PHRASES)


def _all_acks(words: list[str]) -> bool:
    """Every word consumed by the phrase/word lists. Vacuously true when empty."""
    i = 0
    while i < len(words):
        if tuple(words[i : i + 2]) in _ACK_PHRASES:
            i += 2
        elif words[i] in _ACK_WORDS:
            i += 1
        else:
            return False
    return True


def is_backchannel(text: str) -> bool:
    """True when every word is acknowledgment — "Okay.", "Thank you. Okay."."""
    words = _WORDS_RE.findall(text.lower())
    return bool(words) and _all_acks(words)


def _could_still_be_ack(words: list[str]) -> bool:
    """Acknowledgment so far, allowing one trailing cut-off phrase opener.

    Partials stream word by word, so the "thank" of "thank you" arrives on
    its own. Committing the interrupt on the opener is the exact false kill
    this module exists to stop — but only the LAST word gets that grace, so
    "no that's wrong" still interrupts on the very next partial.
    """
    if _all_acks(words):
        return True
    return bool(words) and _all_acks(words[:-1]) and words[-1] in _PHRASE_OPENERS


class UtteranceGate:
    """Per-utterance state machine deciding whether and when to interrupt.

    Pure and synchronous so it stays testable offline; the worker owns the
    clock (the deadline timer) and the side effects (session.barge_in, turn
    dispatch). One instance per STT stream — utterances are sequential.
    """

    def __init__(self) -> None:
        self._open = False
        self._interrupted = False
        self._heard_interim = False

    def start(self) -> None:
        """START_OF_SPEECH: a new utterance; nothing is known about it yet."""
        self._open = True
        self._interrupted = False
        self._heard_interim = False

    def heard(self, interim_text: str) -> bool:
        """Feed one interim; True exactly once, when it proves substantive.

        Scribe partials are cumulative within the utterance — each one
        replaces the last — so only the latest matters and it is classified
        alone. A trailing cut-off phrase opener ("thank" of "thank you")
        keeps the utterance ambiguous and held; see _could_still_be_ack.
        """
        if self._interrupted:
            return False
        text = interim_text.strip()
        if not text:
            return False
        self._heard_interim = True
        if _could_still_be_ack(_WORDS_RE.findall(text.lower())):
            return False
        self._interrupted = True
        return True

    def deadline_passed(self) -> bool:
        """INTERRUPT_DEADLINE_S elapsed; True -> interrupt now.

        Fires only for an utterance still open with NO interim evidence.
        With interims in hand the deadline defers to them — cutting a slow
        "Thank you. Okay." purely on duration is exactly the false kill this
        module exists to stop.
        """
        if not self._open or self._interrupted or self._heard_interim:
            return False
        self._interrupted = True
        return True

    def finish(self, final_text: str, *, tutor_busy: bool) -> bool:
        """FINAL_TRANSCRIPT: close the utterance; True -> drop it, not a turn.

        Dropped means: pure acknowledgment, the tutor holds the floor, and no
        interrupt fired for this utterance (if one did, the reply is already
        dead — answering beats leaving silence). When the tutor is idle the
        same words are an answer ("Yes.") and stay a turn.
        """
        interrupted = self._interrupted
        self._open = False
        self._interrupted = False
        self._heard_interim = False
        return (
            tutor_busy
            and not interrupted
            and bool(final_text)
            and is_backchannel(final_text)
        )
