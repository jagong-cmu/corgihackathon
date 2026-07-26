"""TutorSession — the channel-agnostic tutor brain.

One turn, end to end:

    transcript in
      -> assemble context (persona + memory + retrieval)
      -> stream a Claude turn with the canvas tools attached
      -> split the interleaved stream into speech text and anchored actions
      -> synthesize speech, get character timings
      -> resolve every action's cueMs from those timings
      -> emit audio and timed actions through the ChannelAdapter

Nothing here knows about WebRTC, SMS, or LiveKit. That is the point.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from ..persona import PersonaSpec, build_few_shot_messages, build_system_prompt
from ..providers.base import (
    AvatarProvider,
    LLMProvider,
    Principal,
    RetrievalProvider,
    StreamingTTSProvider,
    TextDelta,
    ToolCall,
    TTSProvider,
    TurnEnd,
)
from .channel import ChannelAdapter
from .chunking import SentenceChunker
from .cue import CharacterTimings, CueQueue, TimedAction, TurnTimeline
from .protocol import WHITEBOARD_ACTIONS, canvas_tool_definitions, validate_action

log = logging.getLogger(__name__)


@dataclass
class TurnResult:
    turn_id: str
    speech_text: str
    actions: list[TimedAction]
    dropped_actions: list[tuple[str, list[str]]] = field(default_factory=list)
    """(action_name, errors) for anything that failed validation. These are
    dropped and logged, never rendered (§13)."""

    stop_reason: str = "end_turn"
    cancelled: bool = False

    first_audio_ms: float | None = None
    """Measured from the start of the turn to the first synthesized segment.
    The ≤1.2s budget (§4) is measured from end-of-user-speech, so the realtime
    adapter adds STT finalization on top of this number."""


@dataclass
class SessionConfig:
    model: str = "claude-sonnet-5"
    """Sonnet 5 is the default for the realtime loop: near-Opus quality on
    reasoning with materially lower latency, which is what the 1.2s budget
    actually needs. Swap to claude-opus-5 for offline evaluation or for the
    pre-rendered library, where latency doesn't bind."""

    effort: str = "low"
    """Voice turns are short and highly constrained by the persona prompt, so
    low effort holds up well here and is the main latency lever. Raise to
    medium if you see shallow reasoning on multi-step problems.

    Do NOT reach for thinking:disabled to save latency — on Opus 5 that has a
    failure mode where a tool call gets written into the visible text instead of
    emitted as a tool_use block, which in this product reads as 'the tutor said
    it was drawing an arrow and didn't'."""

    max_history_turns: int = 12
    retrieval_limit: int = 5
    lead_ms: int = 0

    min_sentence_chars: int = 12
    """Below this, a fragment isn't worth its own TTS request and prosody
    suffers on very short inputs."""

    max_sentence_chars: int = 320
    """Force a flush past this so a model that runs on without punctuation
    can't stall audio indefinitely."""

    toolset: str = "whiteboard"
    """Which board the client renders, and therefore which tools the model gets
    and which operating rules go in the system prompt:

      "whiteboard" — present_visual + reveal_step driving the Chalk VisualSpec
                     renderer (this repo's frontend). The default, because it
                     is the only client actually wired to the data channel.
      "canvas"     — the 12 tldraw actions, for the tldraw client.

    The two are mutually exclusive per session: offering both lets the model
    draw on a board the learner can't see."""


class TutorSession:
    def __init__(
        self,
        *,
        persona: PersonaSpec,
        llm: LLMProvider,
        tts: TTSProvider,
        channel: ChannelAdapter,
        avatar: AvatarProvider | None = None,
        retrieval: RetrievalProvider | None = None,
        config: SessionConfig | None = None,
        user_id: str = "dev",
        principal: Principal | None = None,
    ) -> None:
        self.persona = persona
        self.llm = llm
        self.tts = tts
        self.channel = channel
        self.avatar = avatar
        self.retrieval = retrieval
        self.config = config or SessionConfig()
        self.user_id = user_id

        # Carried for the whole session and handed to every search. §13 wants
        # ACLs enforced per query, so the requester's identity has to survive
        # from session setup down to the SQL — defaulting to owner-only keeps
        # the fallback fail-closed.
        self.principal = principal or Principal.owner(user_id)

        self._history: list[dict[str, Any]] = []
        self._turn_counter = 0
        self._cues = CueQueue()
        toolset = self.config.toolset
        self._tools = canvas_tool_definitions(
            only=WHITEBOARD_ACTIONS if toolset == "whiteboard" else None
        )

        # Stable for the whole session, so it sits ahead of the cache breakpoint.
        # The rules block must match the toolset (build_system_prompt raises on
        # an unknown toolset, which also catches a typo'd TUTOR_TOOLSET early).
        self._system = build_system_prompt(persona, toolset=toolset)
        self._few_shot = build_few_shot_messages(persona)

    # -- context assembly ---------------------------------------------------

    def _next_turn_id(self) -> str:
        self._turn_counter += 1
        return f"t_{self._turn_counter:04d}"

    async def _retrieve(self, query: str) -> str | None:
        """Sync-plane retrieval. Answers 'what does the tutor know' (§7.3)."""
        if self.retrieval is None:
            return None
        try:
            chunks = await self.retrieval.search(
                query, principal=self.principal, limit=self.config.retrieval_limit
            )
        except Exception:
            # Same rule as opening the index: a broken database makes a worse
            # tutor, not a silent one. Without this, one bad query kills the
            # turn before a word is spoken — the learner just hears nothing.
            log.exception("retrieval failed — answering without indexed materials")
            return None
        if not chunks:
            return None
        rendered = "\n\n".join(f"[{c.chunk_id}] {c.text}" for c in chunks)
        return (
            "Relevant excerpts from the learner's own materials. Teach from these "
            "and use show_source when their notation matters:\n\n" + rendered
        )

    def _build_messages(self, transcript: str, context: str | None) -> list[dict[str, Any]]:
        history = self._history[-(self.config.max_history_turns * 2) :]
        user_content = transcript if not context else f"{context}\n\n---\n\n{transcript}"
        return [*self._few_shot, *history, {"role": "user", "content": user_content}]

    # -- the turn -----------------------------------------------------------

    async def handle_transcript(self, transcript: str) -> TurnResult:
        turn_id = self._next_turn_id()
        superseded = self._cues.begin_turn(turn_id)
        if superseded is not None:
            # A new turn started while the last one was still in flight. Its
            # unfired cues are dead (§4) and so is its audio.
            await self._interrupt_output(superseded, "barge_in")

        context = await self._retrieve(transcript)
        messages = self._build_messages(transcript, context)

        timeline = TurnTimeline(turn_id=turn_id, lead_ms=self.config.lead_ms)
        chunker = SentenceChunker(
            min_chars=self.config.min_sentence_chars,
            max_chars=self.config.max_sentence_chars,
        )
        streams_audio = self.channel.capabilities.streams_audio
        dropped: list[tuple[str, list[str]]] = []
        stop_reason = "end_turn"
        first_audio_ms: float | None = None
        started = time.perf_counter()

        async for event in self.llm.stream_turn(
            system=self._system, messages=messages, tools=self._tools
        ):
            if isinstance(event, TextDelta):
                timeline.add_text(event.text)
                if not streams_audio:
                    continue
                # Synthesize each sentence the moment it completes rather than
                # waiting for the whole turn. This is the difference between
                # ~7s and ~1s to first audio.
                for sentence in chunker.feed(event.text):
                    if not self._cues.should_emit(turn_id):
                        break
                    await self._speak_segment(sentence, timeline)
                    if first_audio_ms is None:
                        first_audio_ms = (time.perf_counter() - started) * 1000
                    await self._emit(turn_id, timeline.resolve_ready())

            elif isinstance(event, ToolCall):
                # A tool call ends the model's message, so whatever speech is
                # buffered is final — flush it now instead of holding it until
                # the turn ends. Without this the first round's speech waits for
                # the second round to finish, which is most of the latency.
                # This does not affect anchoring: char_offset was already fixed
                # by add_text.
                if streams_audio and chunker.pending.strip():
                    await self._speak_segment(chunker.flush(), timeline)
                    if first_audio_ms is None:
                        first_audio_ms = (time.perf_counter() - started) * 1000
                    await self._emit(turn_id, timeline.resolve_ready())

                errors = validate_action(event.name, event.input)
                if errors:
                    # Drop, log, continue. Never raise on the render path.
                    dropped.append((event.name, errors))
                    log.warning(
                        "dropping invalid action %s in %s: %s",
                        event.name,
                        turn_id,
                        "; ".join(errors),
                    )
                    continue
                timeline.add_action({"type": event.name, **event.input})

            elif isinstance(event, TurnEnd):
                stop_reason = event.stop_reason

        # A turn superseded mid-stream produces nothing.
        if not self._cues.should_emit(turn_id):
            return TurnResult(
                turn_id=turn_id,
                speech_text=timeline.speech_text,
                actions=[],
                dropped_actions=dropped,
                stop_reason=stop_reason,
                cancelled=True,
            )

        # Flush the tail of the last sentence, which never got a terminator.
        if streams_audio:
            tail = chunker.flush()
            if tail and self._cues.should_emit(turn_id):
                await self._speak_segment(tail, timeline)
                if first_audio_ms is None:
                    first_audio_ms = (time.perf_counter() - started) * 1000
                await self._emit(turn_id, timeline.resolve_ready())

        # Anything anchored past the end of speech fires at the end of audio.
        await self._emit(turn_id, timeline.resolve_remaining())

        # Speech is done, so release the sub-frame tail the adapter is holding.
        if streams_audio:
            await self.channel.flush_audio()

        speech = timeline.speech_text
        self._history.append({"role": "user", "content": transcript})
        if speech.strip():
            self._history.append({"role": "assistant", "content": speech})

        return TurnResult(
            turn_id=turn_id,
            speech_text=speech,
            actions=timeline.resolve(),
            dropped_actions=dropped,
            stop_reason=stop_reason,
            first_audio_ms=first_audio_ms,
        )

    async def _emit(self, turn_id: str, actions: list[TimedAction]) -> None:
        for action in actions:
            if not self._cues.should_emit(turn_id):
                return
            await self.channel.send_action(turn_id, action)

    async def _speak_segment(self, text: str, timeline: TurnTimeline) -> None:
        """Synthesize one sentence and push its audio as soon as it exists."""
        if self.persona.voice is None:
            raise ValueError(
                f"persona {self.persona.id!r} has no voice configured but the channel streams audio"
            )
        voice_id = self.persona.voice.voice_id
        model = self.persona.voice.model

        if isinstance(self.tts, StreamingTTSProvider):
            await self._speak_streaming(text, timeline, voice_id=voice_id, model=model)
        else:
            result = await self.tts.synthesize(text, voice_id=voice_id, model=model)
            timeline.attach_timings(result.timings)
            await self._push_audio(result.audio)

    async def _speak_streaming(
        self, text: str, timeline: TurnTimeline, *, voice_id: str, model: str
    ) -> None:
        """Push each chunk's audio the moment it arrives.

        Timings attach once the segment completes rather than per chunk: cue
        resolution needs the segment's full alignment, and since segments are
        sentence-sized the wait is short. The latency that matters is in the
        audio, which is already flowing.
        """
        characters: list[str] = []
        starts: list[int] = []
        ends: list[int] = []

        async for chunk in self.tts.synthesize_stream(text, voice_id=voice_id, model=model):
            if chunk.audio:
                await self._push_audio(chunk.audio)
            # Chunks with audio but no alignment are normal; skip them here.
            if chunk.characters:
                characters.append(chunk.characters)
                starts.extend(chunk.start_ms)
                ends.extend(chunk.end_ms)

        joined = "".join(characters)
        if joined != text:
            # Losing alignment means losing cue timing for this segment, but the
            # audio already played — degrade to unanchored rather than crash.
            log.warning(
                "alignment mismatch in %s: sent %d chars, aligned %d. "
                "Cues in this segment will be unanchored.",
                timeline.turn_id,
                len(text),
                len(joined),
            )
            return
        timeline.attach_timings(CharacterTimings(characters=joined, start_ms=starts, end_ms=ends))

    async def _push_audio(self, audio: bytes) -> None:
        await self.channel.send_audio(audio)
        if self.avatar is not None:
            await self.avatar.push_audio(audio)

    # -- lifecycle ----------------------------------------------------------

    async def barge_in(self) -> None:
        """The learner started talking. Kill the current turn's output."""
        turn_id = self._cues.active_turn_id
        if turn_id is None:
            return
        self._cues.cancel(turn_id)
        await self._interrupt_output(turn_id, "barge_in")

    async def _interrupt_output(self, turn_id: str, reason: str) -> None:
        """Stop everything the learner can currently see or hear.

        Audio first, deliberately. Cancelling the turn only stops canvas
        actions; audio already sits in the transport's playout buffer and in the
        avatar's queue, and those are what the learner notices. Stopping cues
        but not audio produces the worst version of this: the arrows freeze and
        the tutor talks on over the interruption.
        """
        if self.channel.capabilities.streams_audio:
            await self.channel.stop_audio()
        if self.avatar is not None:
            await self.avatar.interrupt()
        await self.channel.cancel_turn(turn_id, reason)

    async def pause_avatar(self) -> None:
        """Call when the learner is working solo on the board.

        Avatar providers bill per active minute, so an idle hot stream is a
        direct cost leak (§14).
        """
        if self.avatar is not None:
            await self.avatar.pause()

    def student_events(self, events: Sequence[dict[str, Any]]) -> None:
        """Fold student activity into the next turn's context (§5.3).

        Deictic references ("why is THIS negative?") resolve via the shape ids
        carried on the event.
        """
        if not events:
            return
        described = "; ".join(
            f"{e.get('kind')} {', '.join(e.get('shapeIds', [])) or '(no shapes)'}" for e in events
        )
        self._history.append(
            {"role": "user", "content": f"[The learner just did this on the board: {described}]"}
        )
