"""ElevenLabs TTS with character-level timestamps.

The timestamps are the whole reason this provider exists in this shape. A TTS
integration that returns only audio cannot drive the canvas, because there is
nothing to anchor a cue to. Note that the LiveKit ElevenLabs plugin's TTS node
does NOT expose alignment, which is why we talk to the API directly instead.

Critical detail: the API returns BOTH `alignment` and `normalized_alignment`.
Use `alignment` — it indexes the original input text, which is what our
character offsets refer to. `normalized_alignment` indexes the text after number
expansion and punctuation handling ("3" -> "three"), so every offset past the
first normalization would be silently wrong. That desync is very hard to debug
from the symptom, which is "the arrows drift later as the sentence goes on".
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass

from ..core.cue import CharacterTimings
from .base import AudioChunk, SynthesisResult

_BASE_URL = "https://api.elevenlabs.io/v1"

# 48kHz is LiveKit's native rate, so PCM at this rate goes straight into an
# rtc.AudioSource with no resample. Requesting mp3 (the API default) and feeding
# it to an AudioSource produces noise, not speech.
#
# pcm_44100 is Pro-tier only; 48000, 24000 and 16000 work on the base plan.
# Simli wants 16000 — see SimliAvatar.
DEFAULT_OUTPUT_FORMAT = "pcm_48000"


@dataclass(frozen=True)
class _Alignment:
    characters: str
    start_ms: list[int]
    end_ms: list[int]


class ElevenLabsTTS:
    """Satisfies TTSProvider and StreamingTTSProvider.

    Requires the `elevenlabs` extra and an API key.
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = _BASE_URL,
        timeout: float = 10.0,
        output_format: str = DEFAULT_OUTPUT_FORMAT,
        voice_settings: dict | None = None,
    ) -> None:
        try:
            import httpx
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise ImportError(
                "the elevenlabs extra is not installed. Run: uv sync --extra elevenlabs"
            ) from exc

        self.output_format = output_format
        # Persona-tuned stability/similarity_boost. Without sending these, a
        # cloned voice runs on the server-side defaults and the tuned values in
        # the persona store silently do nothing.
        self.voice_settings = voice_settings
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            headers={"xi-api-key": api_key},
            # httpx defaults to keepalive_expiry=5.0, which quietly kills the
            # prewarmed connection during the learner's join-and-ask window —
            # prewarm() would warm a socket nothing ever reuses.
            limits=httpx.Limits(keepalive_expiry=120.0),
        )

    def _body(self, text: str, model: str) -> dict:
        body: dict = {"text": text, "model_id": model}
        if self.voice_settings:
            body["voice_settings"] = self.voice_settings
        return body

    async def prewarm(self) -> None:
        """Establish the HTTPS connection ahead of the first synthesis.

        The first request otherwise pays DNS + TCP + TLS inside the first
        answer's critical path. Any response at all means the pooled connection
        is up — the status code is irrelevant, and errors are the caller's to
        swallow (a failed prewarm costs latency, never the session).
        """
        await self._client.get("/user")

    # -- blocking -----------------------------------------------------------

    async def synthesize(
        self, text: str, *, voice_id: str, model: str = "eleven_flash_v2_5"
    ) -> SynthesisResult:
        """One request, one complete result.

        Kept for the offline CLI and for callers that don't need streaming.
        Measured ~1s to return; prefer synthesize_stream in the live loop.
        """
        response = await self._client.post(
            f"/text-to-speech/{voice_id}/with-timestamps",
            params={"output_format": self.output_format},
            json=self._body(text, model),
        )
        response.raise_for_status()
        payload = response.json()

        alignment = _parse_alignment(payload["alignment"])
        _assert_matches(alignment.characters, text)
        return SynthesisResult(
            audio=base64.b64decode(payload["audio_base64"]),
            timings=CharacterTimings(
                characters=alignment.characters,
                start_ms=alignment.start_ms,
                end_ms=alignment.end_ms,
            ),
        )

    # -- streaming ----------------------------------------------------------

    async def synthesize_stream(
        self, text: str, *, voice_id: str, model: str = "eleven_flash_v2_5"
    ) -> AsyncIterator[AudioChunk]:
        """Yield audio as it is generated. ~330ms to first chunk vs ~1s blocking.

        The endpoint returns NDJSON, one object per chunk, each with
        `audio_base64` and an `alignment`. Two properties measured against the
        live API make this simple:

          - character times are ABSOLUTE across the whole synthesis, not
            relative to each chunk, so the caller concatenates without offset
            arithmetic
          - concatenated alignment equals the input text exactly, preserving the
            contiguity invariant TurnTimeline depends on

        Some chunks carry audio with an empty alignment. That is normal and the
        caller must tolerate it.
        """
        async with self._client.stream(
            "POST",
            f"/text-to-speech/{voice_id}/stream/with-timestamps",
            params={"output_format": self.output_format},
            json=self._body(text, model),
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                payload = json.loads(line)
                audio_b64 = payload.get("audio_base64") or ""
                raw = payload.get("alignment")
                alignment = _parse_alignment(raw) if raw else _EMPTY

                yield AudioChunk(
                    audio=base64.b64decode(audio_b64) if audio_b64 else b"",
                    characters=alignment.characters,
                    start_ms=alignment.start_ms,
                    end_ms=alignment.end_ms,
                )

    async def aclose(self) -> None:
        await self._client.aclose()


_EMPTY = _Alignment(characters="", start_ms=[], end_ms=[])


def _parse_alignment(alignment: dict) -> _Alignment:
    """Convert the API's seconds-based alignment into our ms model."""
    characters: list[str] = alignment.get("characters") or []
    return _Alignment(
        characters="".join(characters),
        start_ms=[int(round(s * 1000)) for s in alignment.get("character_start_times_seconds", [])],
        end_ms=[int(round(s * 1000)) for s in alignment.get("character_end_times_seconds", [])],
    )


def _assert_matches(joined: str, original_text: str) -> None:
    """Loud rather than silent.

    If this fires, every cue in the turn is anchored to the wrong character and
    the canvas drifts out of sync with the speech in a way that looks like a
    rendering bug rather than a data bug.
    """
    if joined != original_text:
        raise ValueError(
            "ElevenLabs alignment does not match the input text — cue timing would "
            f"be silently wrong. Sent {len(original_text)} chars, got {len(joined)}. "
            "Check that `alignment` is being read rather than `normalized_alignment`."
        )
