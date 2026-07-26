"""LiveKit adapter. Skipped unless the `livekit` extra is installed."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

rtc = pytest.importorskip("livekit.rtc", reason="requires the livekit extra")

from tutor_agent.adapters.realtime import CANVAS_TOPIC, LiveKitAdapter  # noqa: E402
from tutor_agent.core.channel import Channel  # noqa: E402
from tutor_agent.core.cue import TimedAction  # noqa: E402


def _adapter() -> tuple[LiveKitAdapter, MagicMock]:
    room = MagicMock()
    room.local_participant.publish_data = AsyncMock()
    return LiveKitAdapter(room=room), room


def _sent(room: MagicMock) -> list[dict]:
    return [
        json.loads(c.args[0].decode()) for c in room.local_participant.publish_data.call_args_list
    ]


class TestWireFormat:
    async def test_action_matches_the_protocol_envelope(self):
        adapter, room = _adapter()
        await adapter.send_action(
            "t_0042", TimedAction({"type": "new_section", "title": "A"}, 0, 1500)
        )

        (frame,) = _sent(room)
        assert frame["type"] == "canvas_action"
        assert frame["turnId"] == "t_0042"
        assert frame["seq"] == 0
        assert frame["cueMs"] == 1500
        assert frame["action"] == {"type": "new_section", "title": "A"}

    async def test_frames_carry_the_protocol_version(self):
        """A client on an older protocol should be able to notice."""
        adapter, room = _adapter()
        await adapter.send_action(
            "t_0001", TimedAction({"type": "camera", "op": "focus", "target": "s1"}, 0, 0)
        )
        assert _sent(room)[0]["v"]

    async def test_cancel_turn_envelope(self):
        adapter, room = _adapter()
        await adapter.cancel_turn("t_0007", "barge_in")
        assert _sent(room) == [{"type": "cancel_turn", "turnId": "t_0007", "reason": "barge_in"}]

    async def test_published_on_the_canvas_topic(self):
        adapter, room = _adapter()
        await adapter.cancel_turn("t_0001", "barge_in")
        assert room.local_participant.publish_data.call_args.kwargs["topic"] == CANVAS_TOPIC

    async def test_actions_are_sent_reliably(self):
        """A dropped action is a missing arrow the learner was told to look at."""
        adapter, room = _adapter()
        await adapter.cancel_turn("t_0001", "barge_in")
        assert room.local_participant.publish_data.call_args.kwargs["reliable"] is True


class TestCapabilities:
    def test_declares_a_realtime_web_channel(self):
        adapter, _ = _adapter()
        assert adapter.channel is Channel.WEB
        assert adapter.capabilities.streams_audio
        assert adapter.capabilities.renders_canvas_live
        assert adapter.capabilities.supports_barge_in


class TestAudio:
    """These build genuine rtc.AudioFrames.

    A MagicMock audio source would accept anything, including the malformed
    frames that crash a real session — so the source is mocked but the frame
    construction is not.
    """

    def _with_source(self):
        adapter, room = _adapter()
        source = MagicMock()
        source.capture_frame = AsyncMock()
        adapter.audio_source = source
        return adapter, source

    def _frames(self, source: MagicMock) -> list:
        return [c.args[0] for c in source.capture_frame.call_args_list]

    async def test_audio_before_track_publish_warns_rather_than_crashes(self, caplog):
        adapter, _ = _adapter()
        adapter.audio_source = None
        await adapter.send_audio(b"\x00\x01")
        assert "before the audio track" in caplog.text

    async def test_odd_length_chunk_does_not_raise(self):
        """The live crash. ElevenLabs chunks on network, not sample, boundaries.

        Before the splitter this raised ValueError inside send_audio, which
        unwound through the turn and killed the reply.
        """
        adapter, source = self._with_source()
        await adapter.send_audio(b"\x00" * 4097)
        assert self._frames(source), "expected at least one frame"

    async def test_every_frame_declares_its_true_length(self):
        # frame.data is a memoryview of int16, so its length is in samples.
        adapter, source = self._with_source()
        await adapter.send_audio(b"\x00" * 5000)
        for frame in self._frames(source):
            assert len(frame.data) == frame.samples_per_channel

    async def test_a_long_segment_is_split_for_barge_in_granularity(self):
        """One giant frame can't be cut short by clear_queue."""
        adapter, source = self._with_source()
        await adapter.send_audio(b"\x00" * (48_000 * 2))  # one second
        frames = self._frames(source)
        assert len(frames) == 50  # 20ms each
        assert all(f.duration <= 0.02 for f in frames)

    async def test_a_sample_split_across_chunks_survives(self):
        adapter, source = self._with_source()
        await adapter.send_audio(b"\x11" * 1919)
        await adapter.send_audio(b"\x22" + b"\x33" * 1920)
        joined = b"".join(bytes(f.data) for f in self._frames(source))
        assert joined[:1919] == b"\x11" * 1919
        assert joined[1919:1920] == b"\x22"

    async def test_flush_emits_the_tail(self):
        adapter, source = self._with_source()
        await adapter.send_audio(b"\x00" * 100)  # under one frame
        assert self._frames(source) == []
        await adapter.flush_audio()
        assert len(self._frames(source)) == 1

    async def test_flush_with_nothing_buffered_is_a_noop(self):
        adapter, source = self._with_source()
        await adapter.flush_audio()
        assert self._frames(source) == []

    async def test_stop_audio_clears_the_playout_queue(self):
        adapter, source = self._with_source()
        await adapter.send_audio(b"\x00" * 5000)
        await adapter.stop_audio()
        source.clear_queue.assert_called_once()

    async def test_stop_audio_drops_the_buffered_fragment(self):
        """Otherwise the tail of an interrupted sentence leads the next one."""
        adapter, source = self._with_source()
        await adapter.send_audio(b"\x42" * 500)
        await adapter.stop_audio()
        await adapter.flush_audio()
        assert self._frames(source) == []

    async def test_stop_audio_before_the_track_exists_is_safe(self):
        adapter, _ = _adapter()
        adapter.audio_source = None
        await adapter.stop_audio()  # must not raise


def test_satisfies_the_channel_adapter_protocol():
    from tutor_agent.core.channel import ChannelAdapter

    adapter, _ = _adapter()
    assert isinstance(adapter, ChannelAdapter)


class TestAvatarProviders:
    """Both vendors run through the same shared plumbing."""

    def _creds(self):
        from tutor_agent.providers.livekit_avatar import AvatarCredentials

        room = MagicMock()
        room.name = "test-room"
        return AvatarCredentials(
            room=room,
            local_identity="agent",
            livekit_url="wss://x",
            livekit_api_key="devkey",
            livekit_api_secret="devsecret0123456789012345678901234567890",
        )

    def _lemonslice(self):
        from tutor_agent.providers.livekit_avatar import LemonSliceAvatar, LemonSliceConfig

        return LemonSliceAvatar(
            config=LemonSliceConfig(api_key="k", agent_id="a"), credentials=self._creds()
        )

    def _simli(self):
        from tutor_agent.providers.livekit_avatar import SimliAvatar, SimliConfig

        return SimliAvatar(config=SimliConfig(api_key="k", face_id="f"), credentials=self._creds())

    def test_both_satisfy_the_avatar_provider_protocol(self):
        from tutor_agent.core.session import AvatarProvider

        assert isinstance(self._lemonslice(), AvatarProvider)
        assert isinstance(self._simli(), AvatarProvider)

    def test_inactive_until_started(self):
        """A failed start must degrade to voice-only, not to silence."""
        assert self._lemonslice().is_active is False
        assert self._simli().is_active is False

    def test_identities_are_distinct(self):
        """They're used to exclude the avatar's own audio from STT."""
        assert self._lemonslice().identity != self._simli().identity

    def test_known_identities_covers_every_provider(self):
        from tutor_agent.providers.livekit_avatar import (
            AVATAR_IDENTITIES,
            known_avatar_identities,
        )

        assert set(AVATAR_IDENTITIES.values()) == set(known_avatar_identities())
        assert "lemonslice" in AVATAR_IDENTITIES

    async def test_push_audio_before_start_is_a_noop(self):
        await self._lemonslice().push_audio(b"\x00\x01")  # must not raise

    async def test_pause_clears_the_buffer(self):
        """Barge-in: stop lip-syncing a sentence the learner interrupted."""
        avatar = self._lemonslice()
        output = MagicMock()
        avatar._output = output
        await avatar.pause()
        output.clear_buffer.assert_called_once()

    async def test_stop_deactivates(self):
        avatar = self._lemonslice()
        avatar._output = MagicMock()
        avatar._active = True
        await avatar.stop()
        assert avatar.is_active is False

    async def test_handshake_failure_degrades_instead_of_raising(self):
        avatar = self._lemonslice()

        async def boom(**kwargs):
            raise RuntimeError("vendor down")

        avatar._open_session = boom
        await avatar.start(avatar_ref="a")
        assert avatar.is_active is False

    def test_simli_payload_pairs_face_and_emotion(self):
        from tutor_agent.providers.livekit_avatar import SIMLI_DEFAULT_EMOTION_ID, SimliConfig

        payload = SimliConfig(api_key="k", face_id="myface").to_payload()
        assert payload["faceId"] == f"myface/{SIMLI_DEFAULT_EMOTION_ID}"

    def test_avatar_rate_is_16k_not_the_publish_rate(self):
        """Sending 48kHz audio to a 16kHz avatar makes the tutor sound like helium."""
        from tutor_agent.adapters.realtime import SAMPLE_RATE
        from tutor_agent.providers.livekit_avatar import AVATAR_SAMPLE_RATE

        assert AVATAR_SAMPLE_RATE == 16_000
        assert AVATAR_SAMPLE_RATE != SAMPLE_RATE


class TestMetricsSink:
    def test_disabled_without_a_path(self, tmp_path):
        from tutor_agent.adapters.worker import TurnMetricsSink

        sink = TurnMetricsSink(None)
        sink.record({"turnId": "t_0001"})  # must not raise
        assert list(tmp_path.iterdir()) == []

    def test_appends_one_json_object_per_turn(self, tmp_path):
        import json as _json

        from tutor_agent.adapters.worker import TurnMetricsSink

        path = tmp_path / "metrics.jsonl"
        sink = TurnMetricsSink(str(path))
        sink.record({"turnId": "t_0001", "firstAudioMs": 940.0})
        sink.record({"turnId": "t_0002", "firstAudioMs": 1310.5})

        rows = [_json.loads(line) for line in path.read_text().splitlines()]
        assert [r["turnId"] for r in rows] == ["t_0001", "t_0002"]

    def test_an_unwritable_sink_never_kills_the_session(self, caplog):
        from tutor_agent.adapters.worker import TurnMetricsSink

        sink = TurnMetricsSink("/nonexistent-dir/metrics.jsonl")
        sink.record({"turnId": "t_0001"})
        sink.record({"turnId": "t_0002"})

        assert "metrics sink disabled" in caplog.text
        # Warned once, not once per turn.
        assert caplog.text.count("metrics sink disabled") == 1


class TestWorkerConfig:
    def test_vad_is_tuned_well_below_the_plugin_default(self):
        """The plugin defaults to 2500ms of silence — more than the whole budget."""
        from tutor_agent.adapters.worker import VAD_OPTIONS

        assert VAD_OPTIONS["min_silence_duration_ms"] <= 1000

    def test_stt_and_output_rates_are_distinct(self):
        from tutor_agent.adapters.realtime import SAMPLE_RATE
        from tutor_agent.adapters.worker import STT_SAMPLE_RATE

        assert STT_SAMPLE_RATE == 16_000
        assert SAMPLE_RATE == 48_000
