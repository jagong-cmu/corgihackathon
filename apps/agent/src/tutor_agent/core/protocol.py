"""Bridge to @tutor/canvas-protocol.

The TypeScript package is the single source of truth (§12). This module reads
its exported JSON Schema bundle so the Python worker validates against exactly
the same definitions the client applies — no hand-maintained Python mirror of
the action set, which would drift within a week.

Regenerate the bundle after any protocol change:

    npm run export-schemas -w @tutor/canvas-protocol
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

_RELATIVE = Path("packages") / "canvas-protocol" / "schemas" / "canvas-protocol.json"


def _find_schema_path() -> Path:
    """Locate the exported bundle by walking up for the repo root.

    Walking beats counting `parents[n]` — the count silently breaks the moment
    a module moves a directory, and the failure surfaces as 36 unrelated test
    failures rather than a path error.

    TUTOR_CANVAS_SCHEMA overrides, for deployments where the agent ships
    without the monorepo alongside it.
    """
    override = os.environ.get("TUTOR_CANVAS_SCHEMA")
    if override:
        return Path(override)

    for parent in Path(__file__).resolve().parents:
        candidate = parent / _RELATIVE
        if candidate.is_file():
            return candidate

    # Not found — return the most plausible location so the error message
    # points somewhere useful.
    for parent in Path(__file__).resolve().parents:
        if (parent / "packages").is_dir():
            return parent / _RELATIVE
    return Path(__file__).resolve().parents[-1] / _RELATIVE


SCHEMA_PATH = _find_schema_path()


class ProtocolNotBuiltError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def load_bundle(path: Path | None = None) -> dict[str, Any]:
    schema_path = path or SCHEMA_PATH
    if not schema_path.is_file():
        raise ProtocolNotBuiltError(
            f"canvas-protocol schemas not found at {schema_path}.\n"
            "Run: npm run export-schemas -w @tutor/canvas-protocol"
        )
    return json.loads(schema_path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def protocol_version() -> str:
    return str(load_bundle()["protocolVersion"])


@lru_cache(maxsize=1)
def action_names() -> tuple[str, ...]:
    return tuple(load_bundle()["actions"].keys())


@lru_cache(maxsize=1)
def _validators() -> dict[str, Draft202012Validator]:
    return {name: Draft202012Validator(schema) for name, schema in load_bundle()["actions"].items()}


def validate_action(name: str, payload: dict[str, Any]) -> list[str]:
    """Validate one action's input. Returns a list of human-readable errors.

    Returns errors rather than raising because the caller's correct response is
    to drop the action and log it, never to crash the turn (§13: "a missing
    arrow is invisible; a crashed canvas ends the lesson").
    """
    validators = _validators()
    if name not in validators:
        return [f"unknown action {name!r}; known actions: {', '.join(sorted(validators))}"]

    errors: list[ValidationError] = sorted(
        validators[name].iter_errors(payload), key=lambda e: list(e.path)
    )
    return [f"{'/'.join(str(p) for p in e.path) or '<root>'}: {e.message}" for e in errors]


# JSON Schema validation keywords that strict tool use rejects. Verified
# against the live API: sending `minimum`/`maximum` on an integer returns
# 400 "For 'integer' type, properties maximum, minimum are not supported".
#
# We strip these from what the API sees but KEEP them in the local validator,
# so a bad holdMs still gets caught before it reaches the client — we just
# catch it ourselves instead of having the model constrained up front.
_STRICT_UNSUPPORTED = frozenset(
    {
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "uniqueItems",
    }
)


def _strip_for_strict(node: Any) -> Any:
    """Recursively rewrite a schema into the subset strict tool use accepts.

    Two transforms:
      - drop the validation keywords in _STRICT_UNSUPPORTED
      - flatten `prefixItems` (from Zod tuples, e.g. GraphSpec.xRange) into a
        plain `items`, since strict mode rejects tuple-typed arrays

    Both are lossy for the MODEL but not for us: the local validator still runs
    the full unsanitized schema, so a 3-element xRange is still caught before it
    reaches the client. We just catch it after generation instead of preventing
    it during.
    """
    if isinstance(node, dict):
        out = {
            key: _strip_for_strict(value)
            for key, value in node.items()
            if key not in _STRICT_UNSUPPORTED and key != "prefixItems"
        }
        prefix_items = node.get("prefixItems")
        if isinstance(prefix_items, list) and prefix_items and "items" not in out:
            first = _strip_for_strict(prefix_items[0])
            rest = [_strip_for_strict(p) for p in prefix_items[1:]]
            # Homogeneous tuple (the common case) -> items: <that schema>.
            # Heterogeneous -> items: anyOf, which loses positional meaning but
            # keeps the element types legal.
            out["items"] = first if all(p == first for p in rest) else {"anyOf": [first, *rest]}
        return out
    if isinstance(node, list):
        return [_strip_for_strict(item) for item in node]
    return node


def _is_strict_safe(node: Any) -> bool:
    """True when every object in the schema is closed.

    Strict tool use requires `additionalProperties: false` on every object. Two
    of our schemas legitimately can't be: SimSpec.params is a free-form record
    (template-specific keys like `restitution`) and SimObject is open for the
    same reason. Closing them would stop the model sending simulation
    parameters at all, which is worse than losing strict validation on one tool.
    """
    if isinstance(node, dict):
        if node.get("type") == "object" and node.get("additionalProperties") is not False:
            return False
        return all(_is_strict_safe(v) for v in node.values())
    if isinstance(node, list):
        return all(_is_strict_safe(v) for v in node)
    return True


def canvas_tool_definitions(
    *, only: tuple[str, ...] | None = None, strict: bool = False
) -> list[dict[str, Any]]:
    """Claude tool definitions built from the exported schemas.

    Mirrors `canvasToolDefinitions()` in the TypeScript package. Both read the
    same registry, so the two sides cannot drift in what the model is offered.

    `eager_input_streaming` is what makes cue timing possible: tool inputs
    stream token-by-token, so we know where in the text a call opened.

    ## Why strict defaults to False

    Tested against the live API. Strict tool use on our action set hits a hard
    wall: with 11 strict tools attached, generation fails with "The compiled
    grammar is too large". Getting under that ceiling would mean cutting either
    the number of actions or the richness of their schemas, and the action set
    is going to grow, not shrink.

    We give up little by turning it off, because strict was never the real
    guarantee here. Every action is validated against the FULL schema in
    validate_action() before it reaches the client, and that check is strictly
    stronger — it enforces the numeric ranges and tuple shapes that strict mode
    cannot even express (they have to be stripped to satisfy it). An invalid
    action is dropped and logged either way; strict would only have moved the
    rejection earlier.

    Set strict=True to opt in for a small subset via `only`, e.g. a
    latency-critical path with two or three simple tools.

    Three separate things break under strict, all found empirically:
      - numeric/length constraints (`minimum`, `maxItems`, ...)  -> stripped
      - tuple `prefixItems` (from Zod tuples in GraphSpec)       -> flattened
      - objects that aren't closed (SimSpec.params)              -> per-action
        downgrade, since closing them would stop the model sending sim params

    Optional properties — those with defaults, absent from `required` — turned
    out to be FINE under strict. That was the original hypothesis and it was
    wrong.

    Also worth knowing: `count_tokens` accepts tool sets that generation later
    rejects (it passed the 11-strict-tool bundle that then hit the grammar
    limit), so it validates schema shape but not compiled-grammar size.
    """
    bundle = load_bundle()
    actions: dict[str, Any] = bundle["actions"]
    names = only or tuple(actions.keys())

    definitions: list[dict[str, Any]] = []
    for name in names:
        if name not in actions:
            raise KeyError(f"unknown action {name!r}")
        schema = dict(actions[name])
        # $schema is meaningful in a schema file but not inside a tool definition.
        schema.pop("$schema", None)

        tool_strict = strict
        if strict:
            schema = _strip_for_strict(schema)
            tool_strict = _is_strict_safe(schema)

        definitions.append(
            {
                "name": name,
                "description": _description_for(name),
                "input_schema": schema,
                "strict": tool_strict,
                "eager_input_streaming": True,
            }
        )
    return definitions


def _description_for(name: str) -> str:
    """Tool description.

    The TypeScript registry holds the canonical descriptions but the JSON Schema
    export doesn't carry them at the top level, so they're mirrored here. This
    is the one place the two sides CAN drift — test_protocol.py asserts the
    action-name sets match, which catches an added or removed action, though not
    a reworded description.
    """
    return _DESCRIPTIONS.get(name, f"Canvas action: {name}")


_DESCRIPTIONS: dict[str, str] = {
    "point_at": (
        "Point at something on the board. Call this whenever you say 'this', 'here', or "
        "'that' about something visible — deictic speech without a pointer is confusing."
    ),
    "highlight": (
        "Highlight a shape or a sub-part of one. Call this when you single out a specific "
        "term, line, or region while explaining it."
    ),
    "write_steps": (
        "Write a worked solution as numbered lines revealed one at a time. Call this for any "
        "multi-step derivation or procedure — do not narrate steps that aren't on the board."
    ),
    "equation": (
        "Render a typeset equation. Call this instead of speaking symbols aloud whenever the "
        "notation itself matters."
    ),
    "graph": (
        "Plot functions, points, tangents, or shaded regions. Call this for anything about "
        "rates of change, area, intersections, or the shape of a relationship."
    ),
    "spawn_sim": (
        "Spawn an interactive, physically-correct simulation themed to the user's "
        "interests. Call this for any concept involving motion, force, sampling, or change "
        "over time."
    ),
    "sim_control": (
        "Play, pause, replay, or change the speed of a running simulation. Use 'speed' with a "
        "low value to slow down the moment you're describing."
    ),
    "sim_update": (
        "Change one parameter of a running simulation so the user sees the effect. Call "
        "this when answering 'what if' questions."
    ),
    "show_source": (
        "Display an excerpt of the user's own material (a slide, a page, a wiki block) so "
        "you can explain on top of it. Prefer this over paraphrasing when their source uses "
        "specific notation or wording."
    ),
    "new_section": (
        "Scroll to fresh board space with a heading. Prefer this over clear_region — the board "
        "is the user's reviewable notes."
    ),
    "clear_region": (
        "Erase a rectangle of the board. Use sparingly; new_section is almost always the "
        "better choice."
    ),
    "camera": "Move the camera to focus on a shape or region already on the board.",
    "present_visual": (
        "Put a whole visual on the whiteboard: a compact spec a deterministic renderer plays "
        "as a draw-on animation. Call it once, early in an explanation, with every element "
        "listed as a drawSequence step — the board mounts with all steps hidden, and each "
        "stays hidden until you reveal it with reveal_step. Calling it again replaces the "
        "board."
    ),
    "reveal_step": (
        "Reveal one step of the visual you presented with present_visual. Call it immediately "
        "before the words that describe that element — it draws on in sync with the words you "
        "speak after the call. Reveal every drawSequence step exactly once, in order, as your "
        "narration reaches it."
    ),
}


# The toolset for the Chalk whiteboard client (root src/ in this repo), which
# renders VisualSpecs rather than tldraw shapes. The tldraw action set and this
# one are mutually exclusive per session: a client renders one or the other,
# and offering both would let the model draw on a board the learner can't see.
WHITEBOARD_ACTIONS: tuple[str, ...] = ("present_visual", "reveal_step")
