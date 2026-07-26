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
    async def test_audio_before_track_publish_warns_rather_than_crashes(self, caplog):
        adapter, _ = _adapter()
        adapter.audio_source = None
        await adapter.send_audio(b"\x00\x01")
        assert "before the audio track" in caplog.text


def test_satisfies_the_channel_adapter_protocol():
    from tutor_agent.core.channel import ChannelAdapter

    adapter, _ = _adapter()
    assert isinstance(adapter, ChannelAdapter)
