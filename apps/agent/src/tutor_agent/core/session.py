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

import asyncio
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
from .cue import CharacterTimings, CueQueue, TimedAction, TurnTimeline, synthetic_timings
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
    """Measured from the start of the turn to the first audio chunk pushed to
    the channel — the moment the learner starts hearing something, not the end
    of the first sentence's synthesis. The ≤1.2s budget (§4) is measured from
    end-of-user-speech, so the realtime adapter adds STT finalization on top
    of this number."""

    llm_first_token_ms: float | None = None
    """Turn start to the model's first text delta. Separates 'the model was
    slow to start' from 'TTS was slow' when first_audio_ms regresses."""

    retrieval_ms: float | None = None
    """Time spent in retrieval ahead of the model call. None when the session
    has no retrieval provider."""


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

    Thinking policy is per model. On Sonnet 5, thinking:disabled is safe and
    worth ~400-900ms of time-to-first-token (verified 2026-07-26: clean
    tool_use emission across whiteboard-heavy turns) — the live worker runs
    that way. On Opus 5 do NOT disable thinking: it has a failure mode where a
    tool call gets written into the visible text instead of emitted as a
    tool_use block, which in this product reads as 'the tutor said it was
    drawing an arrow and didn't'."""

    max_history_turns: int = 12
    retrieval_limit: int = 5
    lead_ms: int = 0

    min_sentence_chars: int = 12
    """Below this, a fragment isn't worth its own TTS request and prosody
    suffers on very short inputs."""

    max_sentence_chars: int = 320
    """Force a flush past this so a model that runs on without punctuation
    can't stall audio indefinitely."""

    finish_sentence_on_barge_in: bool = True
    """How an interruption lands. True (the default): the tutor stops STARTING
    sentences but the one being spoken drains and finishes — a hard mid-word
    cut reads as a glitch, not as yielding the floor. False: queued audio is
    killed instantly (the old behavior), for products where talk-over is worse
    than the glitch."""

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
        # (turn_id, playout end estimate) of the last completed turn. Synthesis
        # finishes long before the learner has HEARD the audio, so barge-in must
        # keep working for the playout tail after finish_turn clears the active
        # turn — but not a moment longer, or ambient room noise "interrupts" an
        # idle tutor forever (clear-buffer RPCs to the avatar, cancel_turn to
        # the client) without a word being spoken.
        self._playing_out: tuple[str, float] | None = None
        # Whether the active turn has pushed any audio yet. STT VAD routinely
        # fires a spurious START_OF_SPEECH within a couple seconds of
        # finalizing the question — exactly while the answer is still
        # synthesizing — and cancelling a turn that hasn't said a word turns
        # that jitter into dead air with a healthy-looking log.
        self._active_turn_spoke = False
        # The active turn's transcript, so preempt() can hand it back when a
        # newer utterance abandons an unspoken turn (split VAD finals, or an
        # interjection during the pre-first-audio gap).
        self._active_transcript: str | None = None
        # perf_counter of the active turn's first pushed audio chunk, so
        # first_audio_ms measures when the learner starts HEARING something
        # rather than when the first sentence finishes synthesizing.
        self._first_audio_at: float | None = None
        # True when preempt() handed the active turn's transcript to the next
        # turn. A transcript either folds forward or stays in history — never
        # both, or the model reads the question twice. Finish-sentence mode
        # makes this reachable: an in-flight sentence can still push audio
        # AFTER preempt() took the "unspoken" path, flipping _active_turn_spoke.
        self._transcript_folded = False
        toolset = self.config.toolset
        self._tools = canvas_tool_definitions(
            only=WHITEBOARD_ACTIONS if toolset == "whiteboard" else None
        )

        # Stable for the whole session, so it sits ahead of the cache breakpoint.
        # The rules block must match the toolset (build_system_prompt raises on
        # an unknown toolset, which also catches a typo'd TUTOR_TOOLSET early).
        self._system = build_system_prompt(persona, toolset=toolset)
        self._few_shot = build_few_shot_messages(persona)
        if self._few_shot:
            # Cache breakpoint on the stable persona prefix. The provider also
            # marks the newest message per request, but that moving mark misses
            # whenever the recent conversation changed shape (history trimmed,
            # retrieval context differs) — this one always hits.
            last = dict(self._few_shot[-1])
            last["content"] = [
                {
                    "type": "text",
                    "text": last["content"],
                    "cache_control": {"type": "ephemeral"},
                }
            ]
            self._few_shot[-1] = last

    # -- context assembly ---------------------------------------------------

    def _next_turn_id(self) -> str:
        self._turn_counter += 1
        return f"t_{self._turn_counter:04d}"

    async def _retrieve(self, query: str) -> str | None:
        """Sync-plane retrieval. Answers 'what does the tutor know' (§7.3)."""
        if self.retrieval is None:
            return None
        try:
            # Bounded: this await sits on the turn's critical path, ahead of
            # the first spoken word, and the budget is 1.2s end to end.
            chunks = await asyncio.wait_for(
                self.retrieval.search(
                    query, principal=self.principal, limit=self.config.retrieval_limit
                ),
                timeout=1.0,
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

    def _build_messages(self, user_content: str) -> list[dict[str, Any]]:
        return [*self._few_shot, *self._history, {"role": "user", "content": user_content}]

    # Fraction of the history cap kept after a trim. The gap between keep and
    # cap is the hysteresis: how many turns pass before the prefix shifts again.
    _TRIM_KEEP_QUARTERS = 3

    def _append_history(self, role: str, content: str) -> None:
        """Append to history, trimming in blocks rather than per turn.

        A rolling `[-limit:]` window shifts the prompt prefix on every turn once
        the cap is hit, and a shifted prefix is a prompt-cache miss on the whole
        conversation. Cutting a chunk at once keeps the prefix byte-stable for
        the next several turns between trims.

        The cut lands on a user-message boundary: history that opens with an
        orphaned assistant half-answer reads (after the API merges consecutive
        same-role turns) as the tutor answering a question that was never asked.
        """
        self._history.append({"role": role, "content": content})
        limit = self.config.max_history_turns * 2
        if len(self._history) > limit:
            drop = len(self._history) - (limit * self._TRIM_KEEP_QUARTERS // 4)
            while drop < len(self._history) and self._history[drop]["role"] != "user":
                drop += 1
            del self._history[:drop]

    def _remember_interrupted_turn(self, user_content: str, timeline: TurnTimeline) -> None:
        """Keep what an interrupted turn actually said.

        A cancelled turn used to vanish from history entirely, so after every
        barge-in the tutor forgot both the question and the half-answer the
        learner just heard — the follow-up ("wait, can you show me an
        example?") arrived with zero context. Only turns that spoke are
        recorded: an unspoken turn's transcript is folded into the next turn
        by preempt(), and recording it here too would double the question.
        The interruption is made explicit so the model reads the abrupt end
        as an interruption rather than a complete thought.

        Recorded speech is truncated to the SYNTHESIZED prefix: speech_text
        accumulates every streamed delta, including sentences the cancel
        dropped before synthesis — history claiming the learner heard those
        makes the tutor refuse to repeat the very steps that were cut off.
        (Hard barge-in can still discard already-pushed audio client-side;
        that overcount is bounded by one sentence.)
        """
        heard = timeline.speech_text[: timeline.synthesized_chars].strip()
        if self._transcript_folded or not self._active_turn_spoke or not heard:
            return
        self._append_history("user", user_content)
        self._append_history("assistant", heard + " [the learner interrupted you here]")

    # -- the turn -----------------------------------------------------------

    async def handle_transcript(self, transcript: str) -> TurnResult:
        turn_id = self._next_turn_id()
        self._active_turn_spoke = False
        self._active_transcript = transcript
        self._transcript_folded = False
        superseded = self._cues.begin_turn(turn_id)
        if superseded is not None:
            # A new turn started while the last one was still in flight. Its
            # unfired cues are dead (§4) and so is its audio.
            self._playing_out = None
            await self._interrupt_output(superseded, "barge_in")
        else:
            # The previous turn finished generating, but its audio may still be
            # playing out — a fast follow-up must stop it like a barge-in would,
            # or the two answers overlap.
            playing = self._playing_out
            if playing is not None:
                self._playing_out = None
                if time.perf_counter() < playing[1]:
                    await self._interrupt_output(playing[0], "barge_in")

        retrieve_started = time.perf_counter()
        context = await self._retrieve(transcript)
        retrieval_ms = (
            (time.perf_counter() - retrieve_started) * 1000 if self.retrieval is not None else None
        )
        # The context-augmented content is also what goes into history below:
        # the next turn's prompt must match this one byte-for-byte up to the
        # cache breakpoint, or the whole conversation re-processes.
        user_content = transcript if not context else f"{context}\n\n---\n\n{transcript}"
        messages = self._build_messages(user_content)

        timeline = TurnTimeline(turn_id=turn_id, lead_ms=self.config.lead_ms)
        chunker = SentenceChunker(
            min_chars=self.config.min_sentence_chars,
            max_chars=self.config.max_sentence_chars,
        )
        streams_audio = self.channel.capabilities.streams_audio
        dropped: list[tuple[str, list[str]]] = []
        stop_reason = "end_turn"
        llm_first_token_ms: float | None = None
        self._first_audio_at = None
        started = time.perf_counter()

        def _cancelled_result() -> TurnResult:
            # Every cancelled exit funnels through here; these fields were
            # once two hand-copied blocks, and new fields only ever made it
            # into one of them.
            self._remember_interrupted_turn(user_content, timeline)
            return TurnResult(
                turn_id=turn_id,
                speech_text=timeline.speech_text,
                actions=[],
                dropped_actions=dropped,
                stop_reason=stop_reason,
                cancelled=True,
                first_audio_ms=(
                    (self._first_audio_at - started) * 1000
                    if self._first_audio_at is not None
                    else None
                ),
                llm_first_token_ms=llm_first_token_ms,
                retrieval_ms=retrieval_ms,
            )

        # preempt() can kill the turn during the retrieval await above.
        # Issuing the model request anyway pays connection + prefill + first
        # token for a discarded answer — while holding the worker's turn lock,
        # queueing the very folded turn that replaced us.
        if not self._cues.should_emit(turn_id):
            stop_reason = "cancelled"
            return _cancelled_result()

        llm_stream = self.llm.stream_turn(
            system=self._system, messages=messages, tools=self._tools
        )
        try:
            async for event in llm_stream:
                if not self._cues.should_emit(turn_id):
                    # Cancelled mid-generation. Bail out of the stream instead
                    # of draining the remaining tool rounds — this loop holds
                    # the worker's turn lock, and every extra round is dead air
                    # for the utterance that caused the cancellation.
                    stop_reason = "cancelled"
                    break
                if isinstance(event, TextDelta):
                    if llm_first_token_ms is None:
                        llm_first_token_ms = (time.perf_counter() - started) * 1000
                    timeline.add_text(event.text)
                    if not streams_audio:
                        continue
                    # Synthesize each sentence the moment it completes rather
                    # than waiting for the whole turn. This is the difference
                    # between ~7s and ~1s to first audio.
                    for sentence in chunker.feed(event.text):
                        if not self._cues.should_emit(turn_id):
                            break
                        await self._speak_segment(sentence, timeline)
                        await self._emit(turn_id, timeline.resolve_ready())

                elif isinstance(event, ToolCall):
                    # A tool call ends the model's message, so whatever speech
                    # is buffered is final — flush it now instead of holding it
                    # until the turn ends. Without this the first round's
                    # speech waits for the second round to finish, which is
                    # most of the latency. This does not affect anchoring:
                    # char_offset was already fixed by add_text.
                    if streams_audio and chunker.pending.strip():
                        await self._speak_segment(chunker.flush(), timeline)
                        await self._emit(turn_id, timeline.resolve_ready())

                    errors = validate_action(event.name, event.input)
                    if errors:
                        # Drop, log, continue. Never raise on the render path.
                        # The error rides back on the event so the provider
                        # returns an is_error tool_result — the model must know
                        # the board never got this action, or it reveals steps
                        # of a visual the learner cannot see.
                        dropped.append((event.name, errors))
                        event.error = (
                            f"Rejected — this {event.name} never reached the board. "
                            f"Fix these problems and call it again: " + "; ".join(errors)
                        )
                        log.warning(
                            "dropping invalid action %s in %s: %s",
                            event.name,
                            turn_id,
                            "; ".join(errors),
                        )
                        continue
                    timeline.add_action({"type": event.name, **event.input})
                    # An action whose anchor is already inside synthesized
                    # speech (present_visual anchors at 0) must go out NOW —
                    # riding the next sentence's flush delays the board mount
                    # by a whole synthesis, and a barge-in in that window
                    # kills it entirely.
                    await self._emit(turn_id, timeline.resolve_ready())

                elif isinstance(event, TurnEnd):
                    stop_reason = event.stop_reason
        finally:
            # The break paths above (barge-in, preempt) would otherwise leave
            # the generator suspended inside an open HTTP stream: the dead
            # turn keeps generating server-side, burning output-token rate
            # limit that then queues the very turn that interrupted it.
            # A no-op when the stream ran to completion.
            await llm_stream.aclose()

        first_audio_ms = (
            (self._first_audio_at - started) * 1000 if self._first_audio_at is not None else None
        )

        # A turn superseded mid-stream produces nothing further — but what it
        # already said out loud stays on the record.
        if not self._cues.should_emit(turn_id):
            return _cancelled_result()

        # Flush the tail of the last sentence, which never got a terminator.
        if streams_audio:
            tail = chunker.flush()
            if tail and self._cues.should_emit(turn_id):
                await self._speak_segment(tail, timeline)
                if first_audio_ms is None and self._first_audio_at is not None:
                    first_audio_ms = (self._first_audio_at - started) * 1000
                await self._emit(turn_id, timeline.resolve_ready())

        # A barge-in can land during the tail segment too — after the
        # mid-stream check above. Flushing or recording playout past this
        # point would emit the very fragment the interruption dropped.
        if not self._cues.should_emit(turn_id):
            return _cancelled_result()

        # Anything anchored past the end of speech fires at the end of audio.
        await self._emit(turn_id, timeline.resolve_remaining())

        # Speech is done, so release the sub-frame tail the adapter is holding,
        # and close the avatar's stream segment — the avatar transport can only
        # survive the next barge-in at a segment boundary.
        if streams_audio:
            await self.channel.flush_audio()
            if self.avatar is not None:
                await self.avatar.flush()

        # This turn can no longer be barged into as an ACTIVE turn, but its
        # audio is still playing out client-side — keep interrupting it until
        # the estimated playout end (see barge_in). Guarded: a barge-in can
        # land during the awaits just above, and re-arming playout state for a
        # turn it cancelled would hand the next utterance a dead turn to
        # "interrupt".
        if self._cues.should_emit(turn_id):
            self._cues.finish_turn(turn_id)
            if first_audio_ms is not None:
                # The estimate must err LONG: audio is pushed in bursts
                # between LLM tool rounds (playout stalls behind generation on
                # long lessons) and the avatar pipeline adds 0.5-2s before the
                # learner hears anything. An over-long window only risks a
                # stray interrupt on an already-quiet turn, which segmented
                # avatar streams now survive.
                audio_end = started + (first_audio_ms + timeline.total_duration_ms) / 1000
                self._playing_out = (turn_id, max(audio_end, time.perf_counter()) + 2.0)

        speech = timeline.speech_text
        # user_content, not transcript: history must replay exactly what this
        # turn's prompt contained (retrieval context included) or the next
        # turn's cache prefix diverges here and the conversation re-processes.
        self._append_history("user", user_content)
        if speech.strip():
            self._append_history("assistant", speech)

        return TurnResult(
            turn_id=turn_id,
            speech_text=speech,
            actions=timeline.resolve(),
            dropped_actions=dropped,
            stop_reason=stop_reason,
            first_audio_ms=first_audio_ms,
            llm_first_token_ms=llm_first_token_ms,
            retrieval_ms=retrieval_ms,
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
            if not self._cues.should_emit(timeline.turn_id) and (
                not self.config.finish_sentence_on_barge_in or not self._active_turn_spoke
            ):
                # Hard barge-in while synthesizing — the audio is dead. The
                # spoke check covers preempt's fold path: "finish the sentence"
                # only makes sense for a sentence the learner started hearing;
                # a turn that never spoke would play an orphan reply to a
                # fragment the next turn is about to re-answer.
                return
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
            if not self._cues.should_emit(timeline.turn_id) and (
                not self.config.finish_sentence_on_barge_in or not self._active_turn_spoke
            ):
                # HARD barge-in mid-sentence: stop pushing NOW. clear_buffer
                # abandons the avatar's current stream, and frames pushed after
                # the interrupt open a fresh segment the avatar would happily
                # play — the cancelled sentence's tail would audibly resume
                # seconds later. In finish-sentence mode nothing is cleared,
                # so completing this sentence's push is exactly the point.
                return
            if chunk.audio:
                await self._push_audio(chunk.audio)
            # Chunks with audio but no alignment are normal; skip them here.
            if chunk.characters:
                characters.append(chunk.characters)
                starts.extend(chunk.start_ms)
                ends.extend(chunk.end_ms)

        joined = "".join(characters)
        if joined != text:
            # The audio already played, so crash is off the table — but simply
            # dropping the timings would shift EVERY later segment's anchors
            # (segment offsets are cumulative over attached character counts).
            # Attach estimated timings for the exact text instead: this
            # segment's cues land approximately, and the rest of the turn stays
            # correctly anchored.
            log.warning(
                "alignment mismatch in %s: sent %d chars, aligned %d. "
                "Using estimated timings for this segment.",
                timeline.turn_id,
                len(text),
                len(joined),
            )
            timeline.attach_timings(synthetic_timings(text))
            return
        timeline.attach_timings(CharacterTimings(characters=joined, start_ms=starts, end_ms=ends))

    async def _push_audio(self, audio: bytes) -> None:
        if self._first_audio_at is None:
            self._first_audio_at = time.perf_counter()
        self._active_turn_spoke = True
        await self.channel.send_audio(audio)
        if self.avatar is not None:
            await self.avatar.push_audio(audio)

    # -- lifecycle ----------------------------------------------------------

    async def prewarm(self) -> None:
        """Pay the session's cold-start costs before the learner's first question.

        Two independent warm-ups, run concurrently: the LLM writes the prompt
        cache (system + tools + few-shot) and opens its connection; the TTS
        opens its connection so the first sentence skips the TLS handshake.
        First turns measured 1-2s slower than warm ones without this.
        Best-effort by design — a failed warm-up costs latency on turn 1,
        never the session.
        """

        tasks = []
        llm_prewarm = getattr(self.llm, "prewarm", None)
        if llm_prewarm is not None:
            tasks.append(
                self._warm(
                    "llm",
                    llm_prewarm(system=self._system, messages=self._few_shot, tools=self._tools),
                )
            )
        tts_prewarm = getattr(self.tts, "prewarm", None)
        if tts_prewarm is not None:
            tasks.append(self._warm("tts", tts_prewarm()))
        if tasks:
            await asyncio.gather(*tasks)

    async def prewarm_tts(self) -> None:
        """Warm just the TTS connection — for when self.tts was rebuilt.

        The worker swaps in a fresh provider (avatar activation, avatar
        fallback), and a fresh provider is a cold connection; the next
        sentence pays the handshake unless it's warmed here. Same best-effort
        contract as prewarm().
        """
        tts_prewarm = getattr(self.tts, "prewarm", None)
        if tts_prewarm is not None:
            await self._warm("tts", tts_prewarm())

    @staticmethod
    async def _warm(name: str, coro: Any) -> None:
        try:
            await coro
        except Exception:
            # exc_info matters: a prewarm that fails EVERY session (auth or
            # config rot) looks identical to a transient blip without it, and
            # the whole latency win silently evaporates.
            log.warning(
                "%s prewarm failed — the next turn pays the cold start", name, exc_info=True
            )

    async def barge_in(self) -> None:
        """The learner started talking. Kill the current turn's output.

        Two cases matter and only these two — a turn still generating, and a
        finished turn whose audio is still playing out. When the tutor is
        actually idle this must be a no-op: START_OF_SPEECH fires on every
        scrap of room noise, and interrupting an idle session means a
        clear-buffer RPC to the avatar and a cancel_turn to the client per
        scrap, for nothing.
        """
        turn_id = self._cues.active_turn_id
        if turn_id is not None:
            if not self._active_turn_spoke:
                # The turn hasn't said a word — there is nothing to talk over.
                # If this speech onset is a real follow-up, its transcript will
                # supersede the turn; if it's VAD jitter (common right after a
                # question finalizes), cancelling here is how a tutor answers
                # with dead air.
                log.debug("barge-in ignored: turn %s has not spoken yet", turn_id)
                return
            log.info("barge-in: interrupting turn %s mid-speech", turn_id)
            self._cues.cancel(turn_id)
            self._playing_out = None
            await self._interrupt_output(turn_id, "barge_in")
            return

        playing = self._playing_out
        if playing is not None:
            self._playing_out = None
            if time.perf_counter() < playing[1]:
                await self._interrupt_output(playing[0], "barge_in")

    async def preempt(self) -> str | None:
        """A newer utterance arrived while a turn is still in flight.

        Mid-speech this is exactly a barge-in. Before the first word, the
        in-flight turn is abandoned silently and its transcript handed back so
        the caller can fold it into the new turn — that keeps split VAD finals
        ("Hey Nico." / "Can you explain X?") and interjections landing in the
        pre-first-audio gap from losing the first fragment, and it frees the
        turn lock in milliseconds instead of after the dead turn drains its
        remaining tool rounds.
        """
        turn_id = self._cues.active_turn_id
        if turn_id is None:
            return None
        if self._active_turn_spoke:
            await self.barge_in()
            return None
        self._cues.cancel(turn_id)
        # The transcript now folds into the next turn; the dying turn must not
        # also write it to history (an in-flight sentence finishing after this
        # point would otherwise trip _remember_interrupted_turn).
        self._transcript_folded = True
        return self._active_transcript

    async def _interrupt_output(self, turn_id: str, reason: str) -> None:
        """Stop what the learner can currently see or hear from a dead turn.

        Two grades. finish_sentence_on_barge_in (the default) lets already-
        synthesized speech drain so the tutor finishes the sentence being
        spoken — a hard mid-word cut reads as a glitch — while the cancel
        upstream stops any FURTHER sentence from starting, and the avatar
        pacing (livekit_avatar PACE_LEAD_MS) bounds how much "already
        synthesized" can be. The hard grade kills queued audio instantly.
        Either way the cue cancel goes out, so the board never draws for
        speech that won't arrive.
        """
        if not self.config.finish_sentence_on_barge_in:
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
        self._append_history(
            "user", f"[The learner just did this on the board: {described}]"
        )
