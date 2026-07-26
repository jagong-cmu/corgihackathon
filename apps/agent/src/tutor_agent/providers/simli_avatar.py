"""Simli avatar, behind our own AvatarProvider protocol.

## Why this isn't `simli.AvatarSession`

The LiveKit plugin's `AvatarSession.start(agent_session, room)` requires an
`AgentSession`, which owns the STT -> LLM -> TTS pipeline. We can't hand ours
over: `AgentSession`'s TTS node doesn't expose character alignment, and without
alignment there is no cue timing and no synchronized canvas.

But reading the plugin shows it touches `agent_session` in exactly one place:

    agent_session.output.replace_audio_tail(
        DataStreamAudioOutput(room=..., destination_identity=..., sample_rate=16000)
    )

That's it. Simli joins the room as its own participant, publishes video and
audio on behalf of our agent, and receives our audio over a LiveKit data
stream. It needs an audio sink, not a pipeline.

So we do the two HTTP calls the plugin does, construct `DataStreamAudioOutput`
ourselves, and satisfy our existing `AvatarProvider` protocol. `capture_frame`
matches `rtc.AudioSource`, and `clear_buffer` is exactly what barge-in needs.
No refactor, no AgentSession, and we keep the cue-timing pipeline.

## Audio routing when the avatar is on

Simli republishes the audio it receives, so the worker must NOT also publish to
its own track — the learner would hear everything twice, slightly offset.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from livekit import api, rtc
from livekit.agents.voice.avatar import DataStreamAudioOutput
from livekit.agents.voice.room_io import ATTRIBUTE_PUBLISH_ON_BEHALF

log = logging.getLogger(__name__)

SIMLI_API_URL = "https://api.simli.ai"

# Simli's ingest rate. Our TTS must be asked for pcm_16000 when the avatar is
# active, otherwise the audio arrives at the wrong speed.
SIMLI_SAMPLE_RATE = 16_000

AVATAR_IDENTITY = "simli-avatar-agent"
AVATAR_NAME = "simli-avatar-agent"

DEFAULT_EMOTION_ID = "92f24a0c-f046-45df-8df0-af7449c04571"


@dataclass
class SimliConfig:
    api_key: str
    face_id: str
    emotion_id: str = DEFAULT_EMOTION_ID
    max_session_length: int = 600
    max_idle_time: int = 30

    def to_payload(self) -> dict:
        return {
            "faceId": f"{self.face_id}/{self.emotion_id}",
            "handleSilence": True,
            "maxSessionLength": self.max_session_length,
            "maxIdleTime": self.max_idle_time,
        }


class SimliAvatar:
    """Satisfies AvatarProvider."""

    def __init__(
        self,
        *,
        config: SimliConfig,
        room: rtc.Room,
        local_identity: str,
        livekit_url: str,
        livekit_api_key: str,
        livekit_api_secret: str,
        api_url: str = SIMLI_API_URL,
    ) -> None:
        self.config = config
        self.room = room
        self.local_identity = local_identity
        self.livekit_url = livekit_url
        self.livekit_api_key = livekit_api_key
        self.livekit_api_secret = livekit_api_secret
        self.api_url = api_url

        self._output: DataStreamAudioOutput | None = None
        self._active = False

    @property
    def is_active(self) -> bool:
        """False until start() succeeds. The worker publishes audio to its own
        track instead when this is False, so a failed avatar degrades to
        voice-only rather than to silence."""
        return self._active

    async def start(self, *, avatar_ref: str | None = None) -> None:
        if avatar_ref:
            self.config.face_id = avatar_ref

        import httpx

        token = (
            api.AccessToken(api_key=self.livekit_api_key, api_secret=self.livekit_api_secret)
            .with_kind("agent")
            .with_identity(AVATAR_IDENTITY)
            .with_name(AVATAR_NAME)
            .with_grants(api.VideoGrants(room_join=True, room=self.room.name))
            # Lets Simli publish its video and audio as if it were us.
            .with_attributes({ATTRIBUTE_PUBLISH_ON_BEHALF: self.local_identity})
            .to_jwt()
        )

        async with httpx.AsyncClient(timeout=20.0) as client:
            session_response = await client.post(
                f"{self.api_url}/compose/token",
                json=self.config.to_payload(),
                headers={"x-simli-api-key": self.config.api_key},
            )
            if session_response.status_code >= 400:
                log.error(
                    "simli token request failed (%s): %s",
                    session_response.status_code,
                    session_response.text[:300],
                )
                return

            session_token = json.loads(session_response.text)["session_token"]

            connect_response = await client.post(
                f"{self.api_url}/integrations/livekit/agents",
                json={
                    "session_token": session_token,
                    "livekit_token": token,
                    "livekit_url": self.livekit_url,
                },
            )
            if connect_response.status_code >= 400:
                log.error(
                    "simli connect failed (%s): %s",
                    connect_response.status_code,
                    connect_response.text[:300],
                )
                return

        self._output = DataStreamAudioOutput(
            room=self.room,
            destination_identity=AVATAR_IDENTITY,
            sample_rate=SIMLI_SAMPLE_RATE,
        )
        self._active = True
        log.info("simli avatar started (face %s)", self.config.face_id)

    async def push_audio(self, audio: bytes) -> None:
        if self._output is None or not audio:
            return
        frame = rtc.AudioFrame(
            data=audio,
            sample_rate=SIMLI_SAMPLE_RATE,
            num_channels=1,
            samples_per_channel=len(audio) // 2,  # 16-bit mono
        )
        await self._output.capture_frame(frame)

    async def pause(self) -> None:
        """Drop queued audio.

        Doubles as barge-in: without it the avatar keeps lip-syncing a sentence
        the learner already interrupted. Also the cost lever — Simli bills per
        active minute.
        """
        if self._output is not None:
            self._output.clear_buffer()

    async def stop(self) -> None:
        if self._output is not None:
            self._output.flush()
        self._output = None
        self._active = False
