"""End-to-end turns against the fakes. No API keys, no network."""

from __future__ import annotations

import pytest

from tutor_agent.core import (
    Channel,
    ChannelCapabilities,
    RecordingAdapter,
    SessionConfig,
    TutorSession,
)
from tutor_agent.persona import load_persona_dir
from tutor_agent.persona.loader import DEFAULT_PERSONA_DIR
from tutor_agent.providers import FakeAvatar, FakeLLM, FakeRetrieval, FakeTTS, ScriptedTurn
from tutor_agent.providers.base import Chunk


def _persona(persona_id: str = "ada"):
    persona = load_persona_dir(DEFAULT_PERSONA_DIR)[persona_id]
    assert persona.voice is not None
    return persona


def _session(turns, *, adapter=None, avatar=None, retrieval=None, persona_id="ada"):
    adapter = adapter or RecordingAdapter()
    return (
        TutorSession(
            persona=_persona(persona_id),
            llm=FakeLLM(turns),
            tts=FakeTTS(),
            channel=adapter,
            avatar=avatar,
            retrieval=retrieval,
            config=SessionConfig(),
        ),
        adapter,
    )


class TestBasicTurn:
    async def test_speech_and_actions_are_emitted(self):
        session, adapter = _session(
            [
                ScriptedTurn(
                    events=[
                        "Okay, so look at this. ",
                        ("equation", {"x": 80, "y": 60, "id": "eq_1", "latex": "x^2 - 4x + 3"}),
                        "That's the one we're factoring.",
                    ]
                )
            ]
        )

        result = await session.handle_transcript("How do I factor this?")

        assert "Okay, so look at this." in result.speech_text
        assert len(result.actions) == 1
        assert result.actions[0].action["type"] == "equation"
        assert len(adapter.frames) == 1
        assert adapter.frames[0]["turnId"] == "t_0001"
        assert adapter.audio

    async def test_action_fires_after_the_preceding_speech(self):
        session, adapter = _session(
            [
                ScriptedTurn(
                    events=[
                        "Here is a reasonably long preamble before anything happens. ",
                        ("point_at", {"target": "eq_1", "style": "laser", "holdMs": 1200}),
                        "Now look here.",
                    ]
                )
            ]
        )
        await session.handle_transcript("show me")
        assert adapter.frames[0]["cueMs"] > 0

    async def test_wire_frame_matches_the_protocol_envelope(self):
        session, adapter = _session(
            [ScriptedTurn(events=[("new_section", {"title": "Part 2"}), "New topic."])]
        )
        await session.handle_transcript("next")

        frame = adapter.frames[0]
        assert set(frame) == {"type", "turnId", "seq", "cueMs", "action"}
        assert frame["type"] == "canvas_action"
        assert frame["seq"] == 0
        assert frame["action"] == {"type": "new_section", "title": "Part 2"}


class TestValidation:
    async def test_invalid_action_is_dropped_not_raised(self):
        """§13: drop, log to event_log, continue. Never crash the turn."""
        session, adapter = _session(
            [
                ScriptedTurn(
                    events=[
                        "Watch. ",
                        ("equation", {"x": 10}),  # missing required y, id, latex
                        "Still talking.",
                    ]
                )
            ]
        )

        result = await session.handle_transcript("go")

        assert result.dropped_actions
        assert result.dropped_actions[0][0] == "equation"
        assert adapter.frames == []
        # Speech is unaffected — the lesson continues.
        assert "Still talking." in result.speech_text

    async def test_unknown_action_is_dropped(self):
        session, adapter = _session(
            [ScriptedTurn(events=["Hm. ", ("summon_demon", {"x": 0}), "Nope."])]
        )
        result = await session.handle_transcript("go")
        assert result.dropped_actions[0][0] == "summon_demon"
        assert adapter.frames == []

    async def test_valid_actions_survive_alongside_invalid_ones(self):
        session, adapter = _session(
            [
                ScriptedTurn(
                    events=[
                        ("new_section", {"title": "Good"}),
                        "text ",
                        ("equation", {"x": 1}),  # bad
                        "more ",
                        ("camera", {"op": "focus", "target": "eq_1"}),
                    ]
                )
            ]
        )
        result = await session.handle_transcript("go")
        assert len(result.dropped_actions) == 1
        assert [f["action"]["type"] for f in adapter.frames] == ["new_section", "camera"]


class TestBargeIn:
    async def test_new_turn_cancels_the_previous(self):
        session, adapter = _session(
            [
                ScriptedTurn(events=["First turn. ", ("new_section", {"title": "A"})]),
                ScriptedTurn(events=["Second turn. ", ("new_section", {"title": "B"})]),
            ]
        )

        await session.handle_transcript("first")
        await session.handle_transcript("second")

        assert adapter.cancellations == [("t_0001", "barge_in")]

    async def test_explicit_barge_in_stops_emission(self):
        session, adapter = _session(
            [ScriptedTurn(events=["Talking. ", ("new_section", {"title": "A"})])]
        )
        await session.handle_transcript("go")
        frames_before = len(adapter.frames)

        await session.barge_in()

        assert adapter.cancellations[-1] == ("t_0001", "barge_in")
        assert len(adapter.frames) == frames_before


class TestChannelAgnosticism:
    async def test_text_channel_skips_tts_and_fires_all_cues_at_zero(self):
        adapter = RecordingAdapter(channel_kind=Channel.SMS, caps=ChannelCapabilities.messaging())
        session, adapter = _session(
            [
                ScriptedTurn(
                    events=[
                        "Here you go. ",
                        ("write_steps", {"x": 0, "y": 0, "id": "s1", "lines": ["one", "two"]}),
                        "Done.",
                    ]
                )
            ],
            adapter=adapter,
        )

        result = await session.handle_transcript("help")

        assert adapter.audio == []  # no TTS on a text channel
        assert [a.cue_ms for a in result.actions] == [0]
        assert adapter.frames  # the same action stream still goes out

    async def test_same_core_produces_actions_on_both_channels(self):
        turns = lambda: [  # noqa: E731
            ScriptedTurn(events=["Look. ", ("new_section", {"title": "A"}), "Here."])
        ]

        web_session, web = _session(turns())
        sms_session, sms = _session(
            turns(),
            adapter=RecordingAdapter(
                channel_kind=Channel.SMS, caps=ChannelCapabilities.messaging()
            ),
        )
        await web_session.handle_transcript("go")
        await sms_session.handle_transcript("go")

        assert [f["action"] for f in web.frames] == [f["action"] for f in sms.frames]


class TestAvatar:
    async def test_audio_is_pushed_to_the_avatar(self):
        avatar = FakeAvatar()
        session, _ = _session([ScriptedTurn(events=["Hello there."])], avatar=avatar)
        await session.handle_transcript("hi")
        assert avatar.audio_chunks

    async def test_pause_avatar_is_callable_for_solo_work(self):
        avatar = FakeAvatar()
        session, _ = _session([ScriptedTurn(events=["Hi."])], avatar=avatar)
        await session.pause_avatar()
        assert avatar.paused == 1


class TestRetrieval:
    async def test_retrieved_chunks_reach_the_prompt(self):
        retrieval = FakeRetrieval(
            [
                Chunk(
                    chunk_id="c1",
                    text="Chapter 4 defines momentum as p = mv.",
                    uri="u",
                    score=0.9,
                )
            ],
            latency_ms=0,
        )
        llm = FakeLLM([ScriptedTurn(events=["Right."])])
        session = TutorSession(
            persona=_persona(),
            llm=llm,
            tts=FakeTTS(),
            channel=RecordingAdapter(),
            retrieval=retrieval,
        )

        await session.handle_transcript("what's momentum")

        last_user = llm.calls[0]["messages"][-1]["content"]
        assert "p = mv" in last_user
        assert retrieval.queries == ["what's momentum"]

    async def test_no_retrieval_provider_is_fine(self):
        session, _ = _session([ScriptedTurn(events=["Sure."])])
        result = await session.handle_transcript("hi")
        assert result.speech_text == "Sure."


class TestPromptAssembly:
    async def test_persona_and_few_shot_are_sent(self):
        llm = FakeLLM([ScriptedTurn(events=["Mm."])])
        session = TutorSession(
            persona=_persona("ada"), llm=llm, tts=FakeTTS(), channel=RecordingAdapter()
        )
        await session.handle_transcript("hello")

        call = llm.calls[0]
        assert "Ada" in call["system"]
        # Few-shot precedes the live turn.
        assert call["messages"][0]["role"] == "user"
        assert len(call["messages"]) > 1
        assert call["messages"][-1]["content"] == "hello"

    async def test_canvas_tools_are_attached(self):
        llm = FakeLLM([ScriptedTurn(events=["Ok."])])
        session = TutorSession(
            persona=_persona(), llm=llm, tts=FakeTTS(), channel=RecordingAdapter()
        )
        await session.handle_transcript("hi")

        names = {t["name"] for t in llm.calls[0]["tools"]}
        assert "equation" in names
        assert "spawn_sim" in names
        assert all(t["eager_input_streaming"] for t in llm.calls[0]["tools"])

    async def test_history_accumulates_across_turns(self):
        llm = FakeLLM([ScriptedTurn(events=["One."]), ScriptedTurn(events=["Two."])])
        session = TutorSession(
            persona=_persona(), llm=llm, tts=FakeTTS(), channel=RecordingAdapter()
        )
        await session.handle_transcript("first")
        await session.handle_transcript("second")

        second_call_messages = llm.calls[1]["messages"]
        contents = [m["content"] for m in second_call_messages]
        assert "first" in contents
        assert "One." in contents

    async def test_student_events_are_folded_into_context(self):
        llm = FakeLLM([ScriptedTurn(events=["I see it."])])
        session = TutorSession(
            persona=_persona(), llm=llm, tts=FakeTTS(), channel=RecordingAdapter()
        )
        session.student_events([{"kind": "drew", "shapeIds": ["shape:abc"]}])
        await session.handle_transcript("why is this wrong?")

        rendered = " ".join(m["content"] for m in llm.calls[0]["messages"])
        assert "drew" in rendered
        assert "shape:abc" in rendered


class TestVoiceRequired:
    async def test_audio_channel_without_a_voice_is_an_error(self):
        persona = _persona().model_copy(update={"voice": None})
        session = TutorSession(
            persona=persona,
            llm=FakeLLM([ScriptedTurn(events=["Hi."])]),
            tts=FakeTTS(),
            channel=RecordingAdapter(),
        )
        with pytest.raises(ValueError, match="no voice configured"):
            await session.handle_transcript("hi")


class TestStreamingTTS:
    """Synthesis happens per sentence, not once after the whole turn."""

    def _turn(self):
        return [
            ScriptedTurn(
                events=[
                    "Okay, so here is the first sentence. ",
                    "Here is a second complete sentence. ",
                    ("new_section", {"title": "Part 2"}),
                    "And a third one to finish the turn.",
                ]
            )
        ]

    async def test_multiple_tts_calls_one_per_sentence(self):
        tts = FakeTTS()
        session = TutorSession(
            persona=_persona(), llm=FakeLLM(self._turn()), tts=tts, channel=RecordingAdapter()
        )
        await session.handle_transcript("go")
        assert len(tts.synthesized) >= 2, "the whole turn was synthesized in one call"

    async def test_synthesized_segments_reassemble_to_the_speech(self):
        """A dropped space here shifts every cue after it."""
        tts = FakeTTS()
        session = TutorSession(
            persona=_persona(), llm=FakeLLM(self._turn()), tts=tts, channel=RecordingAdapter()
        )
        result = await session.handle_transcript("go")
        assert "".join(tts.synthesized) == result.speech_text

    async def test_audio_is_pushed_before_the_turn_ends(self):
        tts = FakeTTS()
        adapter = RecordingAdapter()
        session = TutorSession(
            persona=_persona(), llm=FakeLLM(self._turn()), tts=tts, channel=adapter
        )
        await session.handle_transcript("go")
        assert len(adapter.audio) >= 2, "audio should stream, not arrive as one blob"

    async def test_first_audio_ms_is_measured(self):
        session, _ = _session(self._turn())
        result = await session.handle_transcript("go")
        assert result.first_audio_ms is not None
        assert result.first_audio_ms >= 0

    async def test_actions_still_emit_exactly_once(self):
        session, adapter = _session(self._turn())
        result = await session.handle_transcript("go")
        seqs = [f["seq"] for f in adapter.frames]
        assert seqs == sorted(set(seqs)), "an action was emitted twice"
        assert len(adapter.frames) == len(result.actions)

    async def test_text_channel_still_skips_tts_entirely(self):
        tts = FakeTTS()
        adapter = RecordingAdapter(channel_kind=Channel.SMS, caps=ChannelCapabilities.messaging())
        session = TutorSession(
            persona=_persona(), llm=FakeLLM(self._turn()), tts=tts, channel=adapter
        )
        result = await session.handle_transcript("go")
        assert tts.synthesized == []
        assert result.first_audio_ms is None
        assert adapter.frames
