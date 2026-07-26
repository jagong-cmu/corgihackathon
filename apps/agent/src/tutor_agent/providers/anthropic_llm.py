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
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from typing import Any

from .base import StreamEvent, TextDelta, ToolCall, TurnEnd

_STUB_RESULT = json.dumps({"ok": True})


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
                model=self.model,
                max_tokens=self.max_tokens,
                # Adaptive thinking, depth controlled by effort. Do NOT disable
                # thinking to save latency — see SessionConfig.effort.
                thinking={"type": "adaptive"},
                output_config={"effort": self.effort},
                system=[
                    {
                        "type": "text",
                        "text": system,
                        # Persona + rules are stable for the session, so this
                        # prefix is written once and read on every later turn.
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=convo,
                tools=list(tools),
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
