"""Developer CLI. Everything here runs offline against the fakes.

tutor personas                 list what's available
tutor show ada                 print the compiled system prompt + few-shot
tutor demo ada                 run a scripted turn and draw the cue timeline
tutor tools                    dump the tool definitions sent to Claude
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from .core import RecordingAdapter, TutorSession, canvas_tool_definitions, protocol_version
from .persona import (
    build_few_shot_messages,
    build_system_prompt,
    estimate_prompt_overhead,
    get_persona,
    load_persona_dir,
)
from .providers import FakeLLM, FakeTTS, ScriptedTurn

_DEMO = ScriptedTurn(
    events=[
        "Okay, so here's the thing. ",
        ("new_section", {"title": "Newton's third law"}),
        "Forces always come in pairs. Watch what happens when these two collide. ",
        (
            "spawn_sim",
            {
                "x": 100,
                "y": 80,
                "id": "sim_collision",
                "spec": {
                    "template": "collision_2body",
                    "theme": "basketball",
                    "seed": 7,
                    "objects": [
                        {"sprite": "basketball", "label": "Ball A", "mass": 0.62, "v": 4.2},
                        {"sprite": "basketball", "label": "Ball B", "mass": 0.62, "v": 0},
                    ],
                    "params": {"restitution": 0.85},
                    "overlays": ["force_vectors", "slowmo_at_impact"],
                },
            },
        ),
        "Right at the impact, both arrows appear at the same instant. ",
        ("sim_control", {"id": "sim_collision", "op": "speed", "value": 0.25}),
        "Same length, opposite directions. That's the whole law.",
    ]
)


def _cmd_personas(_: argparse.Namespace) -> int:
    personas = load_persona_dir()
    if not personas:
        print("no personas found", file=sys.stderr)
        return 1
    for persona in personas.values():
        overhead = estimate_prompt_overhead(persona)
        print(
            f"{persona.id:<14} {persona.kind.value:<12} "
            f"{len(persona.few_shot)} few-shot  ~{overhead:,} prompt chars"
        )
    return 0


def _cmd_show(args: argparse.Namespace) -> int:
    persona = get_persona(args.persona)
    print("=" * 72)
    print("SYSTEM PROMPT")
    print("=" * 72)
    print(build_system_prompt(persona))
    print()
    print("=" * 72)
    print("FEW-SHOT MESSAGES")
    print("=" * 72)
    for message in build_few_shot_messages(persona):
        who = "student" if message["role"] == "user" else persona.identity.name
        print(f"\n[{who}]\n{message['content']}")
    print()
    print(f"\n~{estimate_prompt_overhead(persona):,} characters of fixed prompt per session.")
    return 0


def _cmd_tools(args: argparse.Namespace) -> int:
    tools = canvas_tool_definitions(strict=not args.no_strict)
    if args.json:
        print(json.dumps(tools, indent=2))
        return 0
    print(f"canvas-protocol v{protocol_version()} — {len(tools)} tools\n")
    for tool in tools:
        required = tool["input_schema"].get("required", [])
        print(f"  {tool['name']:<14} required: {', '.join(required) or '(none)'}")
    return 0


async def _run_demo(persona_id: str) -> int:
    persona = get_persona(persona_id)
    adapter = RecordingAdapter()
    session = TutorSession(
        persona=persona,
        llm=FakeLLM([_DEMO]),
        tts=FakeTTS(),
        channel=adapter,
    )

    result = await session.handle_transcript("Can you explain Newton's third law?")

    print(f"persona: {persona.identity.name} ({persona.id})")
    print(f"turn:    {result.turn_id}")
    print(f"speech:  {len(result.speech_text)} chars\n")

    print("─" * 72)
    print(f"{'cue':>8}  {'seq':>3}  action")
    print("─" * 72)

    text = result.speech_text
    for action in result.actions:
        # Show which words each action lands on, so desync is visible by eye.
        window = _words_at(text, action.cue_ms, result)
        print(f"{action.cue_ms:>7}ms  {action.seq:>3}  {action.action['type']}")
        print(f"{'':>13}  ...{window}...")
    print("─" * 72)

    if result.dropped_actions:
        print("\nDROPPED (failed validation):")
        for name, errors in result.dropped_actions:
            print(f"  {name}: {'; '.join(errors)}")
        return 1

    print(f"\n{len(adapter.frames)} frames emitted, 0 dropped.")
    return 0


def _words_at(text: str, cue_ms: int, result) -> str:  # noqa: ANN001
    """The words that will be spoken as this action fires."""
    total_ms = max(1, _estimate_total_ms(text))
    index = min(len(text) - 1, int(len(text) * cue_ms / total_ms))
    start = max(0, index - 4)
    return text[start : start + 44].replace("\n", " ")


def _estimate_total_ms(text: str) -> int:
    from .core.cue import synthetic_timings

    return synthetic_timings(text).duration_ms


def _cmd_demo(args: argparse.Namespace) -> int:
    return asyncio.run(_run_demo(args.persona))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tutor", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("personas", help="list available personas").set_defaults(func=_cmd_personas)

    show = sub.add_parser("show", help="print a persona's compiled prompt")
    show.add_argument("persona")
    show.set_defaults(func=_cmd_show)

    demo = sub.add_parser("demo", help="run a scripted turn and show the cue timeline")
    demo.add_argument("persona", nargs="?", default="ada")
    demo.set_defaults(func=_cmd_demo)

    tools = sub.add_parser("tools", help="dump the canvas tool definitions")
    tools.add_argument("--json", action="store_true")
    tools.add_argument("--no-strict", action="store_true")
    tools.set_defaults(func=_cmd_tools)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
