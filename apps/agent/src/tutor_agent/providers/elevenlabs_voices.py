"""Voice management: list the library, and clone from an uploaded sample.

## IVC vs PVC

Two kinds of cloning, and this module implements the first:

  Instant (IVC)       1-2 min of audio, ready in seconds. POST /v1/voices/add.
                      README §3 calls this the standard tier, and it is the only
                      one workable in an onboarding flow.
  Professional (PVC)  ~30 min of audio, hours of training, higher fidelity.
                      POST /v1/voices/pvc. §3 calls it the premium tier.

PVC is deliberately left as a documented seam rather than half-built: it needs a
multi-step upload → verify → train → poll flow, and asking someone for thirty
minutes of audio before their first lesson is not an onboarding step.

## Plan gating

Cloning is a paid feature. On a free plan the API returns HTTP 400 with a
machine-readable `status` of `can_not_use_instant_voice_cloning`, which we
translate into an actionable error rather than surfacing a raw 400.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

log = logging.getLogger(__name__)

_BASE_URL = "https://api.elevenlabs.io/v1"

# The API's machine-readable codes for "your plan doesn't allow this".
_PLAN_GATED = {
    "can_not_use_instant_voice_cloning",
    "can_not_use_professional_voice_cloning",
    "voice_limit_reached",
}


class VoiceCloningUnavailableError(RuntimeError):
    """The account's plan does not permit cloning, or its voice slots are full.

    Distinct from a generic API failure because the fix is a billing action, not
    a retry — the caller should surface it as such rather than as an outage.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class LibraryVoice:
    voice_id: str
    name: str
    category: str
    labels: dict[str, str]
    preview_url: str | None


@dataclass(frozen=True)
class VoiceCapabilities:
    """What this account's plan actually allows. Check before offering cloning
    in a UI — otherwise the user fills in a form and then gets rejected."""

    tier: str
    can_clone_instant: bool
    can_clone_professional: bool
    voice_limit: int
    voices_used: int

    @property
    def slots_remaining(self) -> int:
        return max(0, self.voice_limit - self.voices_used)


class ElevenLabsVoices:
    """Library listing plus instant voice cloning."""

    def __init__(self, *, api_key: str, base_url: str = _BASE_URL, timeout: float = 60.0) -> None:
        try:
            import httpx
        except ImportError as exc:  # pragma: no cover - optional extra
            raise ImportError(
                "the elevenlabs extra is not installed. Run: uv sync --extra elevenlabs"
            ) from exc
        # Generous timeout: cloning uploads a minute or two of audio.
        self._client = httpx.AsyncClient(
            base_url=base_url, timeout=timeout, headers={"xi-api-key": api_key}
        )

    async def capabilities(self) -> VoiceCapabilities:
        subscription = (await self._client.get("/user/subscription")).json()
        voices = (await self._client.get("/voices")).json().get("voices", [])
        return VoiceCapabilities(
            tier=subscription.get("tier", "unknown"),
            can_clone_instant=bool(subscription.get("can_use_instant_voice_cloning")),
            can_clone_professional=bool(subscription.get("can_use_professional_voice_cloning")),
            voice_limit=int(subscription.get("voice_limit", 0)),
            # "My Voices" includes ElevenLabs' ~21 premade library voices, but
            # only CUSTOM voices occupy plan slots. Counting everything
            # reported 24/10 slots on a starter account with 7 real slots
            # free — and the Tutors panel refused to clone because of it.
            voices_used=sum(1 for v in voices if v.get("category") != "premade"),
        )

    async def list_voices(self) -> list[LibraryVoice]:
        response = await self._client.get("/voices")
        response.raise_for_status()
        return [
            LibraryVoice(
                voice_id=v["voice_id"],
                name=v.get("name", ""),
                category=v.get("category", ""),
                labels=v.get("labels") or {},
                preview_url=v.get("preview_url"),
            )
            for v in response.json().get("voices", [])
        ]

    async def clone_instant(
        self,
        *,
        name: str,
        samples: list[tuple[str, bytes, str]],
        description: str | None = None,
    ) -> str:
        """Create an Instant Voice Clone. Returns the new voice_id.

        `samples` is a list of (filename, bytes, content_type). ElevenLabs wants
        1-2 minutes of clean speech; more short clips beat one long noisy one.

        §10: delete the raw upload after enrollment where feasible — the voice
        now lives vendor-side and the sample is biometric data we don't need to
        keep. That deletion is the caller's job (blobs.deleted_at).
        """
        if not samples:
            raise ValueError("instant voice cloning needs at least one audio sample")

        files = [
            ("files", (filename, data, content_type)) for filename, data, content_type in samples
        ]
        form = {"name": name}
        if description:
            form["description"] = description

        response = await self._client.post("/voices/add", data=form, files=files)

        if response.status_code >= 400:
            self._raise_for_error(response)

        voice_id = response.json().get("voice_id")
        if not voice_id:
            raise RuntimeError(f"voice created but no voice_id returned: {response.text[:200]}")
        log.info("created instant voice clone %s (%s)", name, voice_id)
        return voice_id

    async def delete_voice(self, voice_id: str) -> None:
        """§10: deletion requests must propagate vendor-side, not just locally."""
        response = await self._client.delete(f"/voices/{voice_id}")
        if response.status_code >= 400 and response.status_code != 404:
            self._raise_for_error(response)

    @staticmethod
    def _raise_for_error(response) -> None:  # noqa: ANN001
        """Turn an ElevenLabs error body into something a caller can act on."""
        try:
            detail = response.json().get("detail") or {}
        except Exception:
            detail = {}
        code = detail.get("status") if isinstance(detail, dict) else None
        message = detail.get("message") if isinstance(detail, dict) else None

        if code in _PLAN_GATED:
            raise VoiceCloningUnavailableError(
                code,
                message
                or "Voice cloning is not available on this ElevenLabs plan. "
                "Instant Voice Cloning requires Starter or above.",
            )
        raise RuntimeError(
            f"ElevenLabs error {response.status_code}: {message or response.text[:200]}"
        )

    async def aclose(self) -> None:
        await self._client.aclose()


# Professional Voice Cloning is intentionally not implemented. When it is:
#   POST /v1/voices/pvc            create (requires `name` and `language`)
#   POST /v1/voices/pvc/{id}/samples   upload ~30 min of audio
#   POST /v1/voices/pvc/{id}/train     kick off training, then poll for status
# It needs a job-status model the persona flow doesn't have yet, which is why
# it's a seam rather than a stub.
