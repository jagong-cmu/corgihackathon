"""Cartesia TTS, with word timestamps converted into our character model.

## Why not the LiveKit plugin

`livekit-plugins-cartesia` does request `add_timestamps` — but it feeds the
result into `AgentSession`'s transcript synchronizer rather than returning it.
We need `(audio, timings)` in hand to drive cue timing, so this talks to the
SSE endpoint directly, exactly as `ElevenLabsTTS` does.

## Word timestamps vs our character model

Cartesia returns `word_timestamps: {words, start, end}` in seconds — word
granularity, where ElevenLabs gives per-character. That is not a downgrade for
us: `TurnTimeline` snaps every cue to the start of a word (`_next_word_start`),
so word starts are the only values it ever reads. Within-word interpolation is
cosmetic.

The conversion still has to be exact about WHERE each word begins in the
original text, which is why `_locate_words` scans rather than guessing, and
raises instead of silently misaligning.

## use_normalized_timestamps

Set to False. This is the same trap as ElevenLabs' `normalized_alignment`:
normalized timestamps index the text after number expansion and punctuation
handling, so every offset past the first normalization would be quietly wrong.
The symptom is cues drifting later as a sentence goes on, which reads as a
rendering bug rather than a data bug.
"""

from __future__ import annotations

import base64
import json
import logging
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass

from ..core.cue import CharacterTimings
from .base import AudioChunk, SynthesisResult

log = logging.getLogger(__name__)

_BASE_URL = "https://api.cartesia.ai"
API_VERSION = "2025-04-16"
API_VERSION_HEADER = "Cartesia-Version"

# 48kHz mono PCM: LiveKit's native rate, so audio goes straight to an
# rtc.AudioSource with no resample. Avatars ingest at 16k — see AVATAR_SAMPLE_RATE.
DEFAULT_SAMPLE_RATE = 48_000

DEFAULT_MODEL = "sonic-3"


class CartesiaTTS:
    """Satisfies TTSProvider and StreamingTTSProvider."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = _BASE_URL,
        model: str = DEFAULT_MODEL,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        language: str = "en",
        timeout: float = 60.0,
    ) -> None:
        try:
            import httpx
        except ImportError as exc:  # pragma: no cover - optional extra
            raise ImportError(
                "the cartesia extra is not installed. Run: uv sync --extra cartesia"
            ) from exc

        self.model = model
        self.sample_rate = sample_rate
        self.language = language
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            headers={"X-API-Key": api_key, API_VERSION_HEADER: API_VERSION},
        )

    def _body(self, text: str, voice_id: str, model: str | None) -> dict:
        return {
            "model_id": model or self.model,
            "transcript": text,
            "voice": {"mode": "id", "id": voice_id},
            "language": self.language,
            "output_format": {
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": self.sample_rate,
            },
            "add_timestamps": True,
            # See the module docstring — normalized timestamps index a different
            # string than the one we hold, which silently desyncs every cue.
            "use_normalized_timestamps": False,
        }

    # -- streaming ----------------------------------------------------------

    async def synthesize_stream(
        self, text: str, *, voice_id: str, model: str | None = None
    ) -> AsyncIterator[AudioChunk]:
        """Yield audio as it is generated.

        The SSE stream interleaves `chunk` events (base64 audio) and a
        `timestamps` event carrying word timings. Audio arrives before the
        timings, so chunks are emitted with empty alignment and the caller
        receives the timings on the final chunk — which is exactly what
        `TutorSession._speak_streaming` already tolerates, since the real
        ElevenLabs stream also produces audio-only chunks.
        """
        words: list[str] = []
        starts: list[float] = []
        ends: list[float] = []

        async with self._client.stream(
            "POST", "/tts/sse", json=self._body(text, voice_id, model)
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                _raise_for_error(response)

            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = json.loads(line[5:].strip())
                kind = payload.get("type")

                if kind == "chunk" and payload.get("data"):
                    yield AudioChunk(
                        audio=base64.b64decode(payload["data"]),
                        characters="",
                        start_ms=[],
                        end_ms=[],
                    )
                elif kind == "timestamps":
                    wt = payload.get("word_timestamps") or {}
                    words.extend(wt.get("words", []))
                    starts.extend(wt.get("start", []))
                    ends.extend(wt.get("end", []))
                elif kind == "error":
                    raise RuntimeError(f"Cartesia error: {payload.get('error')}")

        timings = word_timestamps_to_characters(text, words, starts, ends)
        # A final alignment-only chunk. The session accumulates `characters`
        # across chunks, so delivering it once at the end is equivalent.
        yield AudioChunk(
            audio=b"",
            characters=timings.characters,
            start_ms=timings.start_ms,
            end_ms=timings.end_ms,
        )

    # -- blocking -----------------------------------------------------------

    async def synthesize(
        self, text: str, *, voice_id: str, model: str | None = None
    ) -> SynthesisResult:
        audio = bytearray()
        characters = ""
        starts: list[int] = []
        ends: list[int] = []
        async for chunk in self.synthesize_stream(text, voice_id=voice_id, model=model):
            audio.extend(chunk.audio)
            if chunk.characters:
                characters = chunk.characters
                starts, ends = chunk.start_ms, chunk.end_ms
        return SynthesisResult(
            audio=bytes(audio),
            timings=CharacterTimings(characters=characters, start_ms=starts, end_ms=ends),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


# ---------------------------------------------------------------------------
# word -> character timings
# ---------------------------------------------------------------------------


class AlignmentMismatchError(ValueError):
    """The returned words could not be located in the text we sent.

    Loud on purpose. A silent mismatch anchors every cue in the turn to the
    wrong character, and the visible symptom — arrows drifting later through a
    sentence — looks like a rendering bug, so it gets debugged in the wrong
    place for hours.
    """


_WS = re.compile(r"\s")


def word_timestamps_to_characters(
    text: str, words: list[str], starts_s: list[float], ends_s: list[float]
) -> CharacterTimings:
    """Expand word timings into a per-character array over `text`.

    Only word-start times are ever read by the cue engine, so characters inside
    a word are interpolated linearly and characters between words inherit the
    preceding word's end. The array is monotonic and exactly `len(text)` long,
    which is what `CharacterTimings` and `TurnTimeline` require.
    """
    if not text:
        return CharacterTimings(characters="", start_ms=[], end_ms=[])

    n = len(text)
    start_ms = [0] * n
    end_ms = [0] * n

    if not words:
        # No timings at all: degrade to a flat zero rather than raising. The
        # caller drops cue anchoring for the segment; the audio still plays.
        return CharacterTimings(characters=text, start_ms=start_ms, end_ms=end_ms)

    spans = _locate_words(text, words)

    cursor = 0
    last_end = 0
    for (lo, hi), start_s, end_s in zip(spans, starts_s, ends_s, strict=False):
        word_start = int(round(start_s * 1000))
        word_end = int(round(end_s * 1000))

        # Gap before this word (spaces, punctuation) holds at the previous end.
        for i in range(cursor, lo):
            start_ms[i] = last_end
            end_ms[i] = last_end

        span = max(1, hi - lo)
        for offset, i in enumerate(range(lo, hi)):
            start_ms[i] = word_start + (word_end - word_start) * offset // span
            end_ms[i] = word_start + (word_end - word_start) * (offset + 1) // span

        cursor = hi
        last_end = word_end

    for i in range(cursor, n):
        start_ms[i] = last_end
        end_ms[i] = last_end

    return CharacterTimings(characters=text, start_ms=start_ms, end_ms=end_ms)


def _locate_words(text: str, words: list[str]) -> list[tuple[int, int]]:
    """(start, end) character span for each word, scanning forward.

    Case-insensitive, and tolerant of whitespace differences inside a returned
    token. Raises rather than skipping — a word we can't place means the
    remaining spans would be shifted, and shifted cues are worse than none.
    """
    lowered = text.lower()
    spans: list[tuple[int, int]] = []
    cursor = 0

    for word in words:
        needle = _WS.sub("", word).lower()
        if not needle:
            continue
        index = lowered.find(needle, cursor)
        if index == -1:
            raise AlignmentMismatchError(
                f"Cartesia returned the word {word!r}, which does not appear in the text we "
                f"sent after position {cursor}. Cue timing would be silently wrong. "
                "Check that use_normalized_timestamps is False."
            )
        spans.append((index, index + len(needle)))
        cursor = index + len(needle)

    return spans


def _raise_for_error(response) -> None:  # noqa: ANN001
    try:
        detail = response.json()
    except Exception:
        detail = response.text[:200]
    raise RuntimeError(f"Cartesia error {response.status_code}: {detail}")


# ---------------------------------------------------------------------------
# Voices: library listing and cloning
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CartesiaVoice:
    voice_id: str
    name: str
    description: str
    language: str
    is_owner: bool


class CloningUnavailableError(RuntimeError):
    """Cloning is not on this account's plan.

    Cartesia answers 402 with a plain-text body rather than the structured
    error code ElevenLabs uses, so this is matched on status rather than a
    machine-readable field. Distinct from a generic failure because the fix is
    a billing action, not a retry.
    """


class CartesiaVoices:
    """Voice library and instant cloning.

    Cartesia clones from ~10s of audio against ElevenLabs' 1-2 minutes, which
    is a materially shorter ask in an onboarding flow. Both vendors gate
    cloning behind a paid plan.
    """

    def __init__(self, *, api_key: str, base_url: str = _BASE_URL, timeout: float = 120.0) -> None:
        import httpx

        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            headers={"X-API-Key": api_key, API_VERSION_HEADER: API_VERSION},
        )

    async def list_voices(self, *, limit: int = 100) -> list[CartesiaVoice]:
        response = await self._client.get("/voices/", params={"limit": limit})
        response.raise_for_status()
        return [
            CartesiaVoice(
                voice_id=v["id"],
                name=v.get("name", ""),
                description=v.get("description", ""),
                language=v.get("language", ""),
                is_owner=bool(v.get("is_owner")),
            )
            for v in response.json().get("data", [])
        ]

    async def clone(
        self,
        *,
        name: str,
        audio: bytes,
        filename: str = "sample.wav",
        content_type: str = "audio/wav",
        language: str = "en",
        mode: str = "similarity",
        enhance: bool = True,
    ) -> str:
        """Clone a voice from a sample. Returns the new voice id.

        `mode`: "similarity" tracks the source voice closely; "stability"
        trades some likeness for more consistent output. Similarity is right
        for a tutor persona, where sounding like the person is the point.
        """
        if not audio:
            raise ValueError("voice cloning needs an audio sample")

        response = await self._client.post(
            "/voices/clone",
            data={
                "name": name,
                "language": language,
                "mode": mode,
                "enhance": str(enhance).lower(),
            },
            files={"clip": (filename, audio, content_type)},
        )
        if response.status_code == 402:
            raise CloningUnavailableError(
                "Voice cloning is not available on this Cartesia plan. "
                "Upgrade at https://play.cartesia.ai/subscription."
            )
        if response.status_code >= 400:
            _raise_for_error(response)

        voice_id = response.json().get("id")
        if not voice_id:
            raise RuntimeError(f"clone succeeded but returned no id: {response.text[:200]}")
        log.info("cloned cartesia voice %s (%s)", name, voice_id)
        return voice_id

    async def delete_voice(self, voice_id: str) -> None:
        """§10: deletion must propagate vendor-side, not just locally."""
        response = await self._client.delete(f"/voices/{voice_id}")
        if response.status_code >= 400 and response.status_code != 404:
            _raise_for_error(response)

    async def aclose(self) -> None:
        await self._client.aclose()
