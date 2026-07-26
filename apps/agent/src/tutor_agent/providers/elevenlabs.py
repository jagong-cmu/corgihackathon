"""ElevenLabs TTS with character-level timestamps.

The timestamps are the whole reason this provider exists in this shape. A TTS
integration that returns only audio cannot drive the canvas, because there is
nothing to anchor a cue to.

Critical detail: the API returns BOTH `alignment` and `normalized_alignment`.
Use `alignment` — it indexes the original input text, which is what our
character offsets refer to. `normalized_alignment` indexes the text after number
expansion and punctuation handling ("3" -> "three"), so every offset past the
first normalization would be silently wrong. That desync is very hard to debug
from the symptom, which is "the arrows drift later as the sentence goes on".
"""

from __future__ import annotations

import base64

from ..core.cue import CharacterTimings
from .base import SynthesisResult

_BASE_URL = "https://api.elevenlabs.io/v1"


class ElevenLabsTTS:
    """Satisfies TTSProvider. Requires the `elevenlabs` extra and an API key."""

    def __init__(self, *, api_key: str, base_url: str = _BASE_URL, timeout: float = 10.0) -> None:
        try:
            import httpx
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise ImportError(
                "the elevenlabs extra is not installed. Run: uv sync --extra elevenlabs"
            ) from exc

        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            headers={"xi-api-key": api_key},
        )

    async def synthesize(
        self, text: str, *, voice_id: str, model: str = "eleven_flash_v2_5"
    ) -> SynthesisResult:
        response = await self._client.post(
            f"/text-to-speech/{voice_id}/with-timestamps",
            json={
                "text": text,
                "model_id": model,
                "output_format": "mp3_44100_128",
            },
        )
        response.raise_for_status()
        payload = response.json()

        audio = base64.b64decode(payload["audio_base64"])
        timings = _parse_alignment(payload["alignment"], text)
        return SynthesisResult(audio=audio, timings=timings)

    async def aclose(self) -> None:
        await self._client.aclose()


def _parse_alignment(alignment: dict, original_text: str) -> CharacterTimings:
    """Convert the API's seconds-based alignment into our ms model."""
    characters: list[str] = alignment["characters"]
    starts = [int(round(s * 1000)) for s in alignment["character_start_times_seconds"]]
    ends = [int(round(s * 1000)) for s in alignment["character_end_times_seconds"]]

    joined = "".join(characters)
    if joined != original_text:
        # Loud rather than silent: if this ever fires, every cue in the turn is
        # anchored to the wrong character and the canvas will drift out of sync
        # with the speech in a way that looks like a rendering bug.
        raise ValueError(
            "ElevenLabs alignment does not match the input text — cue timing would "
            f"be silently wrong. Sent {len(original_text)} chars, got {len(joined)}. "
            "Check that `alignment` is being read rather than `normalized_alignment`."
        )

    return CharacterTimings(characters=joined, start_ms=starts, end_ms=ends)
