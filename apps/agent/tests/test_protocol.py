"""The Python worker and the TypeScript client must not drift.

canvas-protocol is the single source of truth (§12); this file is the tripwire
that fires if the exported bundle and the worker's view of it diverge.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tutor_agent.core.protocol import (
    _DESCRIPTIONS,  # noqa: PLC2701
    SCHEMA_PATH,
    action_names,
    canvas_tool_definitions,
    protocol_version,
    validate_action,
)

FIXTURE_DIR = (
    Path(__file__).resolve().parents[3] / "packages" / "canvas-protocol" / "test" / "fixtures"
)


def test_schema_bundle_is_committed():
    assert SCHEMA_PATH.is_file(), (
        f"missing {SCHEMA_PATH}. Run: npm run export-schemas -w @tutor/canvas-protocol"
    )


def test_protocol_version_is_readable():
    assert protocol_version() == "0.1.0"


def test_all_fourteen_actions_are_present():
    """12 tldraw actions + the 2 whiteboard-toolset actions."""
    assert len(action_names()) == 14
    assert "present_visual" in action_names()
    assert "reveal_step" in action_names()


def test_every_action_has_a_description():
    """Catches an action added to the TS registry but not mirrored here."""
    missing = set(action_names()) - set(_DESCRIPTIONS)
    assert not missing, f"actions missing a Python-side description: {sorted(missing)}"


def test_no_orphaned_descriptions():
    """Catches an action removed from the TS registry but left here."""
    orphaned = set(_DESCRIPTIONS) - set(action_names())
    assert not orphaned, f"descriptions for actions that no longer exist: {sorted(orphaned)}"


class TestValidation:
    def test_valid_action_passes(self):
        assert validate_action("new_section", {"title": "Part 2"}) == []

    def test_missing_required_field_fails(self):
        errors = validate_action("equation", {"x": 1, "y": 2})
        assert errors

    def test_unknown_action_reports_known_ones(self):
        errors = validate_action("nope", {})
        assert len(errors) == 1
        assert "unknown action" in errors[0]
        assert "equation" in errors[0]

    def test_extra_property_is_rejected(self):
        """additionalProperties: false must actually be enforced."""
        errors = validate_action("new_section", {"title": "ok", "sneaky": 1})
        assert errors

    def test_errors_are_returned_not_raised(self):
        """The render path must never see an exception."""
        assert isinstance(validate_action("equation", {}), list)


class TestToolDefinitions:
    def test_one_tool_per_action(self):
        tools = canvas_tool_definitions()
        assert {t["name"] for t in tools} == set(action_names())

    def test_schema_json_key_is_stripped(self):
        """$schema is valid in a schema file but not inside a tool definition."""
        for tool in canvas_tool_definitions():
            assert "$schema" not in tool["input_schema"]

    def test_eager_input_streaming_is_on(self):
        """Cue timing depends on knowing where in the text a call opened."""
        assert all(t["eager_input_streaming"] for t in canvas_tool_definitions())

    def test_strict_is_off_by_default(self):
        """11 strict tools exceed the compiled-grammar limit at generation time.

        validate_action() is the real guarantee and is strictly stronger, so
        strict buys nothing here. See canvas_tool_definitions' docstring.
        """
        assert not any(t["strict"] for t in canvas_tool_definitions())

    def test_strict_can_be_opted_into_for_a_subset(self):
        tools = canvas_tool_definitions(only=("new_section", "camera"), strict=True)
        assert all(t["strict"] for t in tools)

    def test_strict_strips_keywords_the_api_rejects(self):
        """Verified against the live API: `minimum`/`maximum` on an integer 400s."""
        (point_at,) = canvas_tool_definitions(only=("point_at",), strict=True)
        hold = point_at["input_schema"]["properties"]["holdMs"]
        assert "minimum" not in hold and "maximum" not in hold

        # ...but the local validator still enforces them.
        assert validate_action("point_at", {"target": "s1", "holdMs": 99_999})

    def test_strict_flattens_tuple_prefix_items(self):
        """Zod tuples emit prefixItems, which strict tool use rejects."""
        (graph,) = canvas_tool_definitions(only=("graph",), strict=True)

        def has_prefix_items(node) -> bool:
            if isinstance(node, dict):
                return "prefixItems" in node or any(has_prefix_items(v) for v in node.values())
            if isinstance(node, list):
                return any(has_prefix_items(v) for v in node)
            return False

        assert not has_prefix_items(graph["input_schema"])

    def test_open_schemas_downgrade_per_action(self):
        """SimSpec.params is a free-form record; closing it would stop the model
        sending simulation parameters at all, so spawn_sim opts out instead."""
        (spawn_sim,) = canvas_tool_definitions(only=("spawn_sim",), strict=True)
        assert spawn_sim["strict"] is False

        (new_section,) = canvas_tool_definitions(only=("new_section",), strict=True)
        assert new_section["strict"] is True

    def test_subset_selection(self):
        tools = canvas_tool_definitions(only=("equation", "graph"))
        assert {t["name"] for t in tools} == {"equation", "graph"}

    def test_unknown_action_in_subset_raises(self):
        with pytest.raises(KeyError):
            canvas_tool_definitions(only=("nope",))


class TestSharedFixtures:
    """The same golden files the TypeScript side replays into the editor.

    Both tracks validating the same artifacts is the integration contract —
    it's what lets the two halves be built on separate machines and still meet.
    """

    def _fixtures(self) -> list[dict]:
        assert FIXTURE_DIR.is_dir(), f"missing shared fixtures at {FIXTURE_DIR}"
        return [json.loads(p.read_text()) for p in sorted(FIXTURE_DIR.glob("*.json"))]

    def test_fixtures_exist(self):
        assert self._fixtures()

    def test_every_fixture_action_validates_against_the_python_view(self):
        for fixture in self._fixtures():
            for i, message in enumerate(fixture["messages"]):
                if message.get("type") != "canvas_action":
                    continue
                action = dict(message["action"])
                name = action.pop("type")
                errors = validate_action(name, action)
                assert not errors, f"{fixture['name']}[{i}] {name}: {errors}"
