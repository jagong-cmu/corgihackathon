"""Talking-head avatars, behind our own AvatarProvider protocol.

## Why this isn't the plugins' `AvatarSession`

Every LiveKit avatar plugin exposes `AvatarSession.start(agent_session, room)`,
which requires an `AgentSession` — and `AgentSession` owns the STT -> LLM -> TTS
pipeline. We can't hand ours over: its TTS node doesn't expose character
alignment, and without alignment there is no cue timing and no synchronized
canvas.

But reading the LemonSlice and Simli plugins shows they use `agent_session` for
one thing:

    agent_session.output.replace_audio_tail(DataStreamAudioOutput(...))

They need an audio sink, not a pipeline. The avatar service joins the room as
its own participant, publishes video and audio on our behalf, and receives our
audio over a LiveKit data stream at 16kHz.

So we build the sink ourselves and satisfy our own `AvatarProvider` protocol.
`capture_frame` matches `rtc.AudioSource`, and `clear_buffer` is exactly the
barge-in primitive we need.

## Why it's provider-agnostic

The handshake differs per vendor; everything after it is identical. So the
vendor-specific part is one `_open_session` method and the rest is shared. Both
LemonSlice and Simli are ~30 lines each, and switching is a line in the persona
YAML.

## Audio routing

The avatar republishes the audio it receives, so the worker must NOT also
publish to its own track — the learner would hear everything twice, slightly
offset. See `_maybe_start_avatar` in adapters/worker.py.
"""

from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from livekit import api, rtc
from livekit.agents.voice.avatar import DataStreamAudioOutput
from livekit.agents.voice.room_io import ATTRIBUTE_PUBLISH_ON_BEHALF

from ..core.audio import PcmStreamSplitter

if TYPE_CHECKING:
    from PIL import Image

log = logging.getLogger(__name__)

# Every avatar vendor we've looked at ingests 16kHz mono. Our TTS must be asked
# for pcm_16000 when an avatar is active or the speech arrives at the wrong
# speed — a bug that sounds like the tutor is on helium.
AVATAR_SAMPLE_RATE = 16_000

# avatar_ref values of this shape point at a photo in the API's blob store
# (apps/api .../blobs.py writes them). Kept in sync by test_realtime_adapter.
BLOB_REF_PREFIX = "blob:"


def load_blob_image(ref: str, *, dsn: str | None) -> Image.Image | None:
    """The photo behind a `blob:<id>` avatar_ref, as a PIL image, or None.

    Photo uploads live in Postgres (the API's blob store); LemonSlice takes the
    bytes as a multipart upload, so nothing here needs a public URL. Returns
    None on any failure — a missing photo degrades the session to voice-only,
    it must never end it.
    """
    blob_id = ref[len(BLOB_REF_PREFIX) :]
    if not dsn:
        log.warning("avatar_ref %r needs DATABASE_URL to load the photo", ref)
        return None
    try:
        import io

        import psycopg
        from PIL import Image as PILImage

        with psycopg.connect(dsn, autocommit=True) as conn:
            row = conn.execute(
                "SELECT bytes FROM blobs WHERE id = %s AND deleted_at IS NULL", (blob_id,)
            ).fetchone()
        if row is None:
            log.warning("avatar photo blob %s is missing or was purged", blob_id)
            return None
        image = PILImage.open(io.BytesIO(bytes(row[0])))
        image.load()  # decode now, inside the thread that owns the bytes
        return image
    except Exception:
        log.exception("failed to load avatar photo blob %s", blob_id)
        return None


@dataclass
class AvatarCredentials:
    """LiveKit side of the handshake, identical for every vendor."""

    room: rtc.Room
    local_identity: str
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str


class LiveKitAvatar(ABC):
    """Shared avatar plumbing. Satisfies AvatarProvider."""

    identity: str = "avatar-agent"
    name: str = "avatar-agent"

    def __init__(self, credentials: AvatarCredentials) -> None:
        self.credentials = credentials
        self._output: DataStreamAudioOutput | None = None
        self._active = False
        # Same reframing the publish path needs, at the avatar's ingest rate.
        # A chunk ending mid-sample would be rejected by rtc.AudioFrame.
        self._splitter = PcmStreamSplitter(sample_rate=AVATAR_SAMPLE_RATE, num_channels=1)

    @property
    def is_active(self) -> bool:
        """False until start() succeeds.

        The worker keeps publishing to its own audio track while this is False,
        so a missing key or a vendor outage degrades to voice-only rather than
        to silence.
        """
        return self._active

    def _mint_token(self) -> str:
        creds = self.credentials
        return (
            api.AccessToken(api_key=creds.livekit_api_key, api_secret=creds.livekit_api_secret)
            .with_kind("agent")
            .with_identity(self.identity)
            .with_name(self.name)
            .with_grants(api.VideoGrants(room_join=True, room=creds.room.name))
            # Lets the avatar publish its video and audio as if it were us.
            .with_attributes({ATTRIBUTE_PUBLISH_ON_BEHALF: creds.local_identity})
            .to_jwt()
        )

    @abstractmethod
    async def _open_session(self, *, livekit_token: str, avatar_ref: str) -> bool:
        """Vendor handshake. Return True on success, False to degrade gracefully."""

    async def start(self, *, avatar_ref: str = "") -> None:
        try:
            opened = await self._open_session(
                livekit_token=self._mint_token(), avatar_ref=avatar_ref
            )
        except Exception:
            log.exception("%s avatar handshake failed — continuing voice-only", self.identity)
            return
        if not opened:
            return

        self._output = DataStreamAudioOutput(
            room=self.credentials.room,
            destination_identity=self.identity,
            sample_rate=AVATAR_SAMPLE_RATE,
            # Buffer audio until the avatar's video track appears, so speech
            # produced during the handshake gap isn't dropped on the floor.
            wait_remote_track=rtc.TrackKind.KIND_VIDEO,
            wait_playback_start=True,
        )
        self._active = True
        log.info("%s avatar started (ref %s)", self.identity, avatar_ref or "default")

    async def push_audio(self, audio: bytes) -> None:
        if self._output is None or not audio:
            return
        for block in self._splitter.feed(audio):
            await self._output.capture_frame(
                rtc.AudioFrame(
                    data=block,
                    sample_rate=AVATAR_SAMPLE_RATE,
                    num_channels=1,
                    samples_per_channel=self._splitter.samples_per_frame,
                )
            )

    async def interrupt(self) -> None:
        """Barge-in: drop queued audio so the face stops mid-sentence."""
        self._splitter.reset()
        if self._output is not None:
            self._output.clear_buffer()

    async def pause(self) -> None:
        """Stand down while the learner works solo on the board.

        Clears the buffer, which is all we can do without a resume path.
        Deliberately does NOT end the vendor session, so on a provider that
        meters connection time rather than active speech this does not stop the
        meter. Closing that gap means `stop()` here and `start()` again on the
        next turn, at the cost of a handshake mid-lesson — worth measuring
        against a real invoice before choosing (§14).
        """
        self._splitter.reset()
        if self._output is not None:
            self._output.clear_buffer()

    async def stop(self) -> None:
        if self._output is not None:
            self._output.flush()
        self._output = None
        self._active = False
        self._splitter.reset()


# ---------------------------------------------------------------------------
# LemonSlice
# ---------------------------------------------------------------------------


@dataclass
class LemonSliceConfig:
    api_key: str
    agent_id: str | None = None
    """A pre-created LemonSlice agent. Mutually exclusive with agent_image_url."""

    agent_image_url: str | None = None
    """A photo URL — LemonSlice builds the avatar from a single image, no
    training, which is what makes persona onboarding a 30-second step (§3)."""

    agent_image: Image.Image | None = None
    """A photo as a PIL image, sent to LemonSlice as a multipart upload. This is
    how `blob:` avatar_refs (photos in the API's blob store) reach the vendor
    without needing a publicly fetchable URL — the worker resolves the blob to
    bytes before start()."""

    idle_timeout: int = 300
    """Seconds of no inbound audio before LemonSlice ends the avatar session.
    A learner thinking, reading, or working the board in silence is normal in a
    lesson — at the old 30s the face vanished mid-session whenever the tutor
    had nothing to say for half a minute. 300 matches the room's own
    empty-timeout; the room reclaim is what should end things, not the vendor."""

    api_url: str | None = None


def select_lemonslice_source(config: LemonSliceConfig, avatar_ref: str) -> dict[str, Any] | None:
    """The avatar-source kwargs for LemonSliceAPI.start_agent_session, or None.

    The persona's avatar_ref overrides the config: an `http(s)://` ref is a
    photo URL, a `blob:` ref must have been resolved to config.agent_image by
    the caller (returning None here rather than sending the raw ref, which
    LemonSlice would reject as an unknown agent id), and anything else is an
    agent id. Exactly one source is ever returned — the plugin requires it.
    """
    if avatar_ref.startswith(BLOB_REF_PREFIX):
        if config.agent_image is None:
            log.error("unresolved blob avatar_ref %r — the caller must load it", avatar_ref)
            return None
        return {"agent_image": config.agent_image}
    if avatar_ref.startswith(("http://", "https://")):
        return {"agent_image_url": avatar_ref}
    if avatar_ref:
        return {"agent_id": avatar_ref}
    if config.agent_id:
        return {"agent_id": config.agent_id}
    if config.agent_image_url:
        return {"agent_image_url": config.agent_image_url}
    if config.agent_image is not None:
        return {"agent_image": config.agent_image}
    return None


class LemonSliceAvatar(LiveKitAvatar):
    identity = "lemonslice-avatar-agent"
    name = "lemonslice-avatar-agent"

    def __init__(self, *, config: LemonSliceConfig, credentials: AvatarCredentials) -> None:
        super().__init__(credentials)
        self.config = config

    async def _open_session(self, *, livekit_token: str, avatar_ref: str) -> bool:
        from livekit.agents import get_job_context
        from livekit.plugins.lemonslice.api import LemonSliceAPI

        # avatar_ref from the persona overrides the config/env default: an
        # http(s) URL, a resolved blob photo, or an agent id.
        kwargs = select_lemonslice_source(self.config, avatar_ref)
        if kwargs is None:
            log.error(
                "lemonslice needs an agent_id, an image URL, or a photo — set LEMONSLICE_AVATAR_REF"
            )
            return False

        job_ctx = get_job_context()
        session_id = job_ctx.job.room.sid or await self.credentials.room.sid

        async with LemonSliceAPI(
            api_key=self.config.api_key, api_url=self.config.api_url
        ) as client:
            await client.start_agent_session(
                livekit_url=self.credentials.livekit_url,
                livekit_token=livekit_token,
                livekit_session_id=session_id,
                idle_timeout=self.config.idle_timeout,
                **kwargs,
            )
        return True


# ---------------------------------------------------------------------------
# Simli
# ---------------------------------------------------------------------------

SIMLI_API_URL = "https://api.simli.ai"
SIMLI_DEFAULT_EMOTION_ID = "92f24a0c-f046-45df-8df0-af7449c04571"


@dataclass
class SimliConfig:
    api_key: str
    face_id: str
    emotion_id: str = SIMLI_DEFAULT_EMOTION_ID
    max_session_length: int = 600
    max_idle_time: int = 30
    api_url: str = SIMLI_API_URL

    def to_payload(self) -> dict:
        return {
            "faceId": f"{self.face_id}/{self.emotion_id}",
            "handleSilence": True,
            "maxSessionLength": self.max_session_length,
            "maxIdleTime": self.max_idle_time,
        }


class SimliAvatar(LiveKitAvatar):
    identity = "simli-avatar-agent"
    name = "simli-avatar-agent"

    def __init__(self, *, config: SimliConfig, credentials: AvatarCredentials) -> None:
        super().__init__(credentials)
        self.config = config

    async def _open_session(self, *, livekit_token: str, avatar_ref: str) -> bool:
        import httpx

        if avatar_ref:
            self.config.face_id = avatar_ref

        async with httpx.AsyncClient(timeout=20.0) as client:
            token_response = await client.post(
                f"{self.config.api_url}/compose/token",
                json=self.config.to_payload(),
                headers={"x-simli-api-key": self.config.api_key},
            )
            if token_response.status_code >= 400:
                log.error(
                    "simli token request failed (%s): %s",
                    token_response.status_code,
                    token_response.text[:300],
                )
                return False

            connect_response = await client.post(
                f"{self.config.api_url}/integrations/livekit/agents",
                json={
                    "session_token": json.loads(token_response.text)["session_token"],
                    "livekit_token": livekit_token,
                    "livekit_url": self.credentials.livekit_url,
                },
            )
            if connect_response.status_code >= 400:
                log.error(
                    "simli connect failed (%s): %s",
                    connect_response.status_code,
                    connect_response.text[:300],
                )
                return False
        return True


# ---------------------------------------------------------------------------

#: persona.avatar.provider -> the identity that participant will join under.
AVATAR_IDENTITIES: dict[str, str] = {
    "lemonslice": LemonSliceAvatar.identity,
    "simli": SimliAvatar.identity,
}


def known_avatar_identities() -> frozenset[str]:
    """Identities to exclude from STT — otherwise the tutor transcribes its own
    voice coming back through the avatar and answers itself."""
    return frozenset(AVATAR_IDENTITIES.values())
