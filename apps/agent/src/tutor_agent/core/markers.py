"""Inline reveal markers: ``[[reveal:step-id]]`` embedded in the model's speech.

A reveal used to be a tool call, and a tool call ends the model's message —
so a five-step lesson cost five extra API round trips, each one a second-plus
of dead air the learner heard between narration beats. A marker rides INSIDE
the text stream instead: the session strips it from what gets spoken and
anchors a ``reveal_step`` wire action at exactly the character it occupied.
The timing contract is identical to the tool call's (the cue fires on the
first word after the marker) and the speech is one continuous stream.

The scanner is stateful because the model streams text in arbitrary chunks:
a marker can arrive split across any number of deltas ("[[rev" + "eal:ax" +
"es]]"). At each feed the scanner releases everything it can prove is plain
speech and holds back only the shortest suffix that could still become a
marker, so speech is never delayed by more than one in-flight marker.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MARKER_RE = re.compile(r"\[\[reveal:([A-Za-z0-9_.-]{1,64})\]\]")

_HEAD = "[[reveal:"
_ID_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")
_MAX_ID = 64


@dataclass(frozen=True)
class RevealMarker:
    step_id: str


class RevealMarkerScanner:
    """Splits streamed text into clean speech pieces and reveal markers."""

    def __init__(self) -> None:
        self._held = ""

    def feed(self, chunk: str) -> list[str | RevealMarker]:
        buf = self._held + chunk
        self._held = ""
        out: list[str | RevealMarker] = []

        pos = 0
        while pos < len(buf):
            start = buf.find("[[", pos)
            if start == -1:
                # No opener left — but a trailing single '[' could pair with
                # a '[' at the start of the next chunk.
                cut = len(buf) - 1 if buf.endswith("[") else len(buf)
                if cut > pos:
                    out.append(buf[pos:cut])
                self._held = buf[cut:]
                return out

            if start > pos:
                out.append(buf[pos:start])

            match = MARKER_RE.match(buf, start)
            if match:
                out.append(RevealMarker(step_id=match.group(1)))
                pos = match.end()
                continue

            rest = buf[start:]
            if self._viable_prefix(rest):
                # Could still complete into a marker on the next delta.
                self._held = rest
                return out

            # Provably not a marker ("[[x", "[[reveal:!", over-long id...) —
            # the opener is literal prose. Release it and rescan after it.
            out.append(buf[start : start + 2])
            pos = start + 2

        return out

    def flush(self) -> tuple[str, str]:
        """End of turn. Returns (speech_text, dropped_marker_fragment).

        A held single '[' is prose and comes back as speech. A held viable
        marker prefix can never complete now; speaking "[[reveal:ax" aloud is
        worse than losing it, so it is dropped and returned separately for
        the caller to log.
        """
        held, self._held = self._held, ""
        if held.startswith("[["):
            return "", held
        return held, ""

    @staticmethod
    def _viable_prefix(s: str) -> bool:
        """True if `s` (which starts with "[[") could still grow into a marker."""
        if len(s) <= len(_HEAD):
            return _HEAD.startswith(s)
        if not s.startswith(_HEAD):
            return False
        rest = s[len(_HEAD) :]
        i = 0
        while i < len(rest) and rest[i] in _ID_CHARS:
            i += 1
            if i > _MAX_ID:
                return False
        if i == 0:
            return False  # "[[reveal:" followed by a non-id character
        if i == len(rest):
            return True  # still reading the id
        # The id has ended: only a lone ']' (half of the closer) keeps hope
        # alive — a full ']]' would have matched MARKER_RE above.
        return rest[i:] == "]"
