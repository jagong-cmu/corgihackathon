"""Anthropic provider. Requires the `anthropic` extra and an API key.

## Why this class owns the tool-result loop

Canvas actions are fire-and-forget: the client renders them, nothing comes back.
But the API still expects a `tool_result` for every `tool_use` before the turn
can continue. So this provider runs that round trip internally, acking each
canvas tool with a stub result immediately, and yields the core a single flat
ordered stream of TextDelta and ToolCall events.

That keeps `TutorSession` free of Anthropic-shaped plumbing, and it keeps the
latency where it belongs — a canvas action never blocks on the client.

Merge Agent Handler tools, when they arrive in Phase 5, must NOT be acked this
way: they leave our infrastructure, can exceed a second, and must be narration
covered (§7.3). Route them through a separate branch that resolves out of band.

Server-side tools (web_search) are a third case: the API executes them itself
mid-stream, so they need no ack at all. They surface here only as extra content
blocks (`server_tool_use`, `web_search_tool_result`) that must ride along
unchanged when a turn continues into another round, and as the `pause_turn`
stop reason when the server's own tool loop wants to be resumed.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from typing import Any

from .base import StreamEvent, TextDelta, ToolCall, TurnEnd

_STUB_RESULT = json.dumps({"ok": True})

# Block types that accept a cache_control mark. Server-tool blocks
# (server_tool_use, web_search_tool_result) do not — marking one 400s.
_CACHEABLE_BLOCK_TYPES = {"text", "image", "tool_use", "tool_result", "document"}


def _cache_marked(messages: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Copy of `messages` with a cache breakpoint on the final content block.

    The system prompt was already cached, but the conversation was not: every
    turn re-processed the few-shot block and the whole history, and every tool
    round within a turn re-processed the entire prompt again — for a whiteboard
    lesson that is 6-9 full re-reads, each one a pause the learner hears.
    Marking the newest message makes this request's prefix the next request's
    cache hit, both round-to-round and turn-to-turn.

    A copy, not a mutation: the caller reuses these dicts across rounds and
    turns, and a mark left behind would pile up breakpoints past the API's
    limit of four.
    """
    if not messages:
        return []
    last = dict(messages[-1])
    content = last["content"]
    if isinstance(content, str):
        blocks: list[dict[str, Any]] = [{"type": "text", "text": content}]
    else:
        blocks = [dict(block) for block in content]
    if blocks[-1].get("type", "text") not in _CACHEABLE_BLOCK_TYPES:
        # A pause_turn continuation can end on a server-tool block, which
        # cannot carry the mark. Skipping it costs one round of cache reuse;
        # marking it kills the whole request.
        return list(messages)
    blocks[-1] = {**blocks[-1], "cache_control": {"type": "ephemeral"}}
    last["content"] = blocks
    return [*messages[:-1], last]


class AnthropicLLM:
    """Satisfies LLMProvider."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str = "claude-sonnet-5",
        effort: str = "low",
        max_tokens: int = 2048,
        max_tool_rounds: int = 4,
        thinking: str = "adaptive",
    ) -> None:
        try:
            from anthropic import AsyncAnthropic
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise ImportError(
                "the anthropic extra is not installed. Run: uv sync --extra anthropic"
            ) from exc

        # Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
        # or an `ant auth login` profile. Only pass api_key when injecting one.
        self._client = AsyncAnthropic(api_key=api_key) if api_key else AsyncAnthropic()
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens
        self.max_tool_rounds = max_tool_rounds
        # One dict reused by stream_turn AND prewarm: a thinking-config
        # mismatch between them writes a prompt-cache entry the real turns
        # can never read (measured — the cache keys on thinking config).
        self._thinking = {"type": thinking}

    def _request_kwargs(self, system: str, tools: Sequence[dict[str, Any]]) -> dict[str, Any]:
        """Everything the prompt cache keys on, built in exactly one place.

        stream_turn and prewarm must send byte-identical model/thinking/
        output_config/system/tools or the warm-up writes a cache entry the
        real turns can never hit — an invariant a comment can't enforce.
        """
        return {
            "model": self.model,
            "thinking": self._thinking,
            "output_config": {"effort": self.effort},
            "system": [
                {
                    "type": "text",
                    "text": system,
                    # Persona + rules are stable for the session, so this
                    # prefix is written once and read on every later turn.
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            "tools": list(tools),
        }

    async def prewarm(
        self,
        *,
        system: str,
        messages: Sequence[dict[str, Any]] = (),
        tools: Sequence[dict[str, Any]] = (),
    ) -> None:
        """Write the session's cache prefix and open the connection before turn 1.

        The first real turn otherwise pays DNS + TLS to the API plus an uncached
        read of the system prompt, tool schemas, and few-shot block — first
        turns measured 1-2s slower than later ones. One tiny request at session
        start moves all of that off the first answer's critical path.

        `messages` must be the same few-shot prefix (with the same cache marks)
        the real turns will send, and the thinking/output config must match
        stream_turn's — a mismatch in either writes a cache entry the real
        turns can never hit.
        """
        await self._client.messages.create(
            **self._request_kwargs(system, tools),
            max_tokens=64,
            messages=[*messages, {"role": "user", "content": "Ready?"}],
        )

    async def stream_turn(
        self,
        *,
        system: str,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]],
    ) -> AsyncIterator[StreamEvent]:
        convo: list[dict[str, Any]] = list(messages)
        stop_reason = "end_turn"
        last_char = ""

        for _ in range(self.max_tool_rounds):
            assistant_blocks: list[dict[str, Any]] = []
            tool_results: list[dict[str, Any]] = []
            round_started_text = False

            async with self._client.messages.stream(
                **self._request_kwargs(system, tools),
                max_tokens=self.max_tokens,
                messages=_cache_marked(convo),
            ) as stream:
                async for event in stream:
                    if event.type == "content_block_delta" and event.delta.type == "text_delta":
                        text = event.delta.text
                        # Rounds are separate messages, so the model doesn't know
                        # the previous one ended mid-flow. Without a separator the
                        # speech concatenates as "together.Okay" — which TTS reads
                        # as one word and which shifts every downstream cue.
                        if not round_started_text and last_char and not last_char.isspace():
                            if text and not text[0].isspace():
                                yield TextDelta(text=" ")
                        round_started_text = True
                        last_char = text[-1] if text else last_char
                        yield TextDelta(text=text)

                message = await stream.get_final_message()

            stop_reason = message.stop_reason or "end_turn"

            for block in message.content:
                if block.type == "text":
                    assistant_blocks.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    assistant_blocks.append(
                        {
                            "type": "tool_use",
                            "id": block.id,
                            "name": block.name,
                            "input": block.input,
                        }
                    )
                    # Ordered relative to the text already yielded above, which
                    # is what anchors the cue.
                    call = ToolCall(id=block.id, name=block.name, input=dict(block.input))
                    yield call
                    # The consumer validated the call during the yield; a
                    # rejected action goes back as is_error so the model fixes
                    # the spec and calls again instead of narrating a board
                    # that never mounted.
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": call.error or _STUB_RESULT,
                            **({"is_error": True} if call.error else {}),
                        }
                    )
                else:
                    # Server-tool blocks (server_tool_use, web_search_tool_result)
                    # and thinking blocks. Executed or produced API-side, so there
                    # is nothing to ack — but they must round-trip verbatim if
                    # this turn continues into another round, or the API rejects
                    # the replayed conversation as inconsistent.
                    assistant_blocks.append(block.model_dump(exclude_none=True))

            if stop_reason == "pause_turn":
                # The server-side tool loop (web_search) paused mid-turn.
                # Re-send with the partial assistant message appended and no
                # tool results; the server resumes where it left off.
                convo = [*convo, {"role": "assistant", "content": assistant_blocks}]
                continue

            if stop_reason != "tool_use" or not tool_results:
                break

            # Ack and continue. All results go back in ONE user message —
            # splitting them trains the model out of parallel tool calls.
            convo = [
                *convo,
                {"role": "assistant", "content": assistant_blocks},
                {"role": "user", "content": tool_results},
            ]

        yield TurnEnd(stop_reason=stop_reason)
