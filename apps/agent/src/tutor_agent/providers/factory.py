"""Build a TTS provider from a persona.

`VoiceConfig.provider` already existed and was always "elevenlabs" — it now
actually selects. Both vendors stay in the tree behind `TTSProvider`, so
switching is a line in a persona YAML rather than a code change, and the two can
be A/B'd on real audio instead of argued about.

Sample rate is a runtime decision, not a persona one: 48kHz straight into
LiveKit's AudioSource normally, 16kHz when an avatar is active because every
avatar vendor ingests at 16k.
"""

from __future__ import annotations

import os

from ..persona import PersonaSpec
from .base import TTSProvider


class VoiceProviderError(RuntimeError):
    """The persona asks for a provider we can't build."""


def make_tts(persona: PersonaSpec, *, sample_rate: int = 48_000) -> TTSProvider:
    """Instantiate the TTS provider this persona's voice asks for."""
    if persona.voice is None:
        raise VoiceProviderError(f"persona {persona.id!r} has no voice configured")

    provider = persona.voice.provider

    if provider == "elevenlabs":
        from .elevenlabs import ElevenLabsTTS

        return ElevenLabsTTS(
            api_key=_require("ELEVENLABS_API_KEY", provider),
            output_format=f"pcm_{sample_rate}",
            voice_settings={
                "stability": persona.voice.stability,
                "similarity_boost": persona.voice.similarity_boost,
            },
        )

    if provider == "cartesia":
        from .cartesia import CartesiaTTS

        return CartesiaTTS(
            api_key=_require("CARTESIA_API_KEY", provider),
            sample_rate=sample_rate,
            # VoiceConfig.model defaults to an ElevenLabs model name, so a
            # persona that switched provider without updating it would send
            # nonsense. Fall back to Cartesia's default in that case.
            model=persona.voice.model if _looks_like_cartesia(persona.voice.model) else None,
        )

    raise VoiceProviderError(
        f"persona {persona.id!r} asks for unknown voice provider {provider!r}; "
        "known providers: elevenlabs, cartesia"
    )


def _looks_like_cartesia(model: str) -> bool:
    return model.startswith("sonic")


def _require(name: str, provider: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise VoiceProviderError(f"{name} is not set, but a persona asks for {provider} voice")
    return value
