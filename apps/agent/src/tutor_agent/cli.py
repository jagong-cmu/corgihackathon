"""Developer CLI. Everything here runs offline against the fakes.

tutor personas                 list what's available
tutor show ada                 print the compiled system prompt + few-shot
tutor demo ada                 run a scripted turn and draw the cue timeline
tutor tools                    dump the tool definitions sent to Claude
tutor chunk notes.md           preview how a document will be split

These need Postgres (uv sync --extra postgres, DATABASE_URL set):

tutor ingest notes.md --user U --upload ID    index a file
tutor ask "what's on the midterm" --user U    search it, with the 150ms budget shown
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


# -- retrieval ---------------------------------------------------------------


def _embedder(name: str):
    """Offline by default. The fake ranks plausibly, so `tutor ask` is useful
    without a Voyage key — just not semantic."""
    from .retrieval import HashingEmbeddings

    if name == "hashing":
        return HashingEmbeddings()
    import os

    from .retrieval.embeddings import VoyageEmbeddings

    key = os.environ.get("VOYAGE_API_KEY")
    if not key:
        raise SystemExit("VOYAGE_API_KEY is not set (or pass --embedder hashing)")
    return VoyageEmbeddings(api_key=key)


def _uuid_arg(value: str, what: str) -> str:
    """Fail with one line instead of an asyncpg codec traceback.

    These ids are pasted from psql often enough that a stray newline or a
    truncated copy is the normal failure, and the raw error buries that under
    forty frames of protocol internals.
    """
    import uuid

    try:
        return str(uuid.UUID(value.strip()))
    except ValueError as exc:
        raise SystemExit(f"--{what} must be a uuid, got {value.strip()!r}") from exc


async def _open_store(args: argparse.Namespace):
    import os

    try:
        import asyncpg
    except ImportError as exc:
        raise SystemExit(
            "the postgres extra is not installed. Run: uv sync --extra postgres"
        ) from exc

    from .retrieval.pgvector import PgVectorRetrieval

    dsn = args.dsn or os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("pass --dsn or set DATABASE_URL")
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    return pool, PgVectorRetrieval(pool=pool, embeddings=_embedder(args.embedder))


async def _run_ingest(args: argparse.Namespace) -> int:
    from pathlib import Path

    from .retrieval.pgvector import Acl, SourceRef

    path = Path(args.path)
    text = path.read_text(encoding="utf-8", errors="replace")

    pool, store = await _open_store(args)
    try:
        source = SourceRef(
            user_id=_uuid_arg(args.user, "user"),
            upload_id=_uuid_arg(args.upload, "upload"),
        )
        acl = Acl.shared_with(args.principal) if args.principal else Acl.owner()
        count = await store.upsert_document(
            source=source,
            uri=args.uri or path.as_uri(),
            title=args.title or path.name,
            text=text,
            acl=acl,
        )
        print(f"indexed {count} chunk(s) from {path.name}")
    finally:
        await pool.close()
    return 0


async def _run_ask(args: argparse.Namespace) -> int:
    import time

    from .providers.base import Principal

    pool, store = await _open_store(args)
    try:
        principal = Principal(
            user_id=_uuid_arg(args.user, "user"), groups=frozenset(args.group)
        )
        started = time.perf_counter()
        hits = await store.search(args.query, principal=principal, limit=args.limit)
        elapsed = (time.perf_counter() - started) * 1000

        # The in-loop budget is 150ms (§4) and this sits on the critical path
        # ahead of the model, so print it every time rather than on request.
        verdict = "OK" if elapsed <= 150 else "OVER BUDGET"
        print(f"{len(hits)} hit(s) in {elapsed:.0f}ms ({verdict}, budget 150ms)\n")
        for hit in hits:
            print(f"  {hit.score:.3f}  {hit.title or hit.uri}")
            body = " ".join(hit.text.split())
            print(f"         {body[:160]}{'…' if len(body) > 160 else ''}\n")
    finally:
        await pool.close()
    return 0


def _cmd_ingest(args: argparse.Namespace) -> int:
    return asyncio.run(_run_ingest(args))


def _cmd_ask(args: argparse.Namespace) -> int:
    return asyncio.run(_run_ask(args))


def _cmd_chunk(args: argparse.Namespace) -> int:
    """No database, no keys — just look at how a document will be split."""
    from pathlib import Path

    from .retrieval import chunk_document

    text = Path(args.path).read_text(encoding="utf-8", errors="replace")
    chunks = chunk_document(text, target_chars=args.target, overlap_chars=args.overlap)
    for chunk in chunks:
        body = " ".join(chunk.text.split())
        print(f"[{chunk.ix:03d}] {len(chunk.text):5d} chars  {body[:110]}…")
    print(f"\n{len(chunks)} chunk(s)")
    return 0


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

    chunk = sub.add_parser("chunk", help="preview how a document will be split (no database)")
    chunk.add_argument("path")
    chunk.add_argument("--target", type=int, default=1200)
    chunk.add_argument("--overlap", type=int, default=180)
    chunk.set_defaults(func=_cmd_chunk)

    def _store_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--dsn", help="defaults to $DATABASE_URL")
        p.add_argument("--user", required=True, help="owning user id (uuid)")
        p.add_argument(
            "--embedder",
            default="hashing",
            choices=("hashing", "voyage"),
            help="hashing runs offline; voyage needs VOYAGE_API_KEY",
        )

    ingest = sub.add_parser("ingest", help="chunk, embed, and index a local file")
    _store_args(ingest)
    ingest.add_argument("path")
    ingest.add_argument("--upload", required=True, help="uploads.id this file was stored as")
    ingest.add_argument("--uri")
    ingest.add_argument("--title")
    ingest.add_argument(
        "--principal",
        action="append",
        default=[],
        help="restrict to these ACL principals (repeatable); omit for owner-only",
    )
    ingest.set_defaults(func=_cmd_ingest)

    ask = sub.add_parser("ask", help="search the index as a given principal")
    _store_args(ask)
    ask.add_argument("query")
    ask.add_argument(
        "--group", action="append", default=[], help="a group the requester holds (repeatable)"
    )
    ask.add_argument("--limit", type=int, default=5)
    ask.set_defaults(func=_cmd_ask)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
