"""Unit tests for the provider's cache-mark helper. No SDK, no network —
the anthropic import lives inside AnthropicLLM.__init__, so the module and
its pure helpers are importable offline.
"""

from __future__ import annotations

from tutor_agent.providers.anthropic_llm import _cache_marked


class TestCacheMarked:
    def test_string_content_becomes_a_marked_block(self):
        marked = _cache_marked([{"role": "user", "content": "hello"}])
        assert marked == [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "hello", "cache_control": {"type": "ephemeral"}}
                ],
            }
        ]

    def test_only_the_final_block_of_the_final_message_is_marked(self):
        messages = [
            {"role": "user", "content": "q"},
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "a", "content": "{}"},
                    {"type": "tool_result", "tool_use_id": "b", "content": "{}"},
                ],
            },
        ]
        marked = _cache_marked(messages)
        assert marked[0] == {"role": "user", "content": "q"}
        assert "cache_control" not in marked[1]["content"][0]
        assert marked[1]["content"][1]["cache_control"] == {"type": "ephemeral"}

    def test_input_is_not_mutated(self):
        """The caller reuses these dicts across rounds and turns — a mark left
        behind would pile up breakpoints past the API's limit of four."""
        block = {"type": "text", "text": "hi"}
        messages = [{"role": "user", "content": [block]}]
        _cache_marked(messages)
        assert block == {"type": "text", "text": "hi"}
        assert messages == [{"role": "user", "content": [block]}]

    def test_empty_messages(self):
        assert _cache_marked([]) == []
