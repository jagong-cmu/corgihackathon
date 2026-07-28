"""Prove every leg of the live loop works before spending a session debugging it.

    set -a && . ../../.env.local && set +a
    uv run python scripts/preflight.py
    uv run python scripts/preflight.py --persona coach-rios --skip avatar

Each check exercises the same code path the worker uses, not a simplified
stand-in — the point is to fail here, with a specific message, rather than
inside a room with a learner waiting. Costs well under a cent (one short TTS
request, one 1-token LLM call).

Exit code is 0 only if nothing FAILed. WARN means degraded but usable: a missing
avatar key drops you to voice-only, which is a legitimate way to run.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from dataclasses import dataclass, field
from enum import StrEnum

# The learner-facing budget (§4). Individual legs must leave room for each other.
BUDGET_MS = 1200


class Status(StrEnum):
    PASS = "PASS"
    WARN = "WARN"
    FAIL = "FAIL"
    SKIP = "SKIP"


_GLYPH = {Status.PASS: "✓", Status.WARN: "!", Status.FAIL: "✗", Status.SKIP: "-"}
_COLOR = {
    Status.PASS: "\033[32m",
    Status.WARN: "\033[33m",
    Status.FAIL: "\033[31m",
    Status.SKIP: "\033[90m",
}
_RESET = "\033[0m"


@dataclass
class Result:
    name: str
    status: Status
    detail: str = ""
    fix: str = ""
    timing_ms: float | None = None


@dataclass
class Report:
    results: list[Result] = field(default_factory=list)

    def add(self, result: Result) -> Result:
        self.results.append(result)
        colour = _COLOR[result.status] if sys.stdout.isatty() else ""
        reset = _RESET if sys.stdout.isatty() else ""
        timing = f" ({result.timing_ms:.0f}ms)" if result.timing_ms is not None else ""
        print(f"  {colour}{_GLYPH[result.status]}{reset} {result.name}{timing}")
        if result.detail:
            print(f"      {result.detail}")
        if result.fix and result.status in (Status.FAIL, Status.WARN):
            print(f"      → {result.fix}")
        return result

    @property
    def failed(self) -> bool:
        return any(r.status is Status.FAIL for r in self.results)


def section(title: str) -> None:
    print(f"\n{title}")


# ---------------------------------------------------------------------------
# environment
# ---------------------------------------------------------------------------

REQUIRED = {
    "ANTHROPIC_API_KEY": "the tutor brain",
    "ELEVENLABS_API_KEY": "STT and TTS",
    "LIVEKIT_URL": "the room to join",
    "LIVEKIT_API_KEY": "minting join tokens",
    "LIVEKIT_API_SECRET": "minting join tokens",
}

PLACEHOLDERS = {
    # What `livekit-server --dev` prints. Committed in .env.local as a template,
    # and the single most likely reason a first live run fails to authenticate.
    "LIVEKIT_API_KEY": {"devkey", "APIxxxxxxxxxxx"},
    "LIVEKIT_API_SECRET": {"secret"},
}


def check_env(report: Report) -> None:
    section("environment")
    for name, why in REQUIRED.items():
        value = os.environ.get(name, "")
        if not value:
            report.add(
                Result(
                    name,
                    Status.FAIL,
                    f"unset — needed for {why}",
                    "set -a && . ../../.env.local && set +a",
                )
            )
        elif value in PLACEHOLDERS.get(name, set()):
            report.add(
                Result(
                    name,
                    Status.FAIL,
                    f"still the dev placeholder ({value!r})",
                    "paste your LiveKit Cloud project credentials into .env.local",
                )
            )
        else:
            report.add(Result(name, Status.PASS, f"set ({len(value)} chars)"))

    url = os.environ.get("LIVEKIT_URL", "")
    if url and not url.startswith(("ws://", "wss://")):
        report.add(
            Result(
                "LIVEKIT_URL scheme",
                Status.FAIL,
                f"{url!r} is not a websocket URL",
                "it should look like wss://<project>.livekit.cloud",
            )
        )


# ---------------------------------------------------------------------------
# persona
# ---------------------------------------------------------------------------


def check_persona(report: Report, persona_id: str):
    section(f"persona: {persona_id}")
    try:
        from tutor_agent.persona import get_persona

        persona = get_persona(persona_id)
    except Exception as exc:
        report.add(
            Result(
                "load",
                Status.FAIL,
                f"{type(exc).__name__}: {exc}",
                "uv run tutor personas — lists what is loadable",
            )
        )
        return None

    report.add(Result("load", Status.PASS, f"{persona.identity.name} ({persona.kind})"))

    if persona.voice is None:
        report.add(
            Result(
                "voice",
                Status.FAIL,
                "no voice configured",
                "a realtime persona needs voice.voice_id — the loop cannot speak",
            )
        )
    else:
        report.add(
            Result("voice", Status.PASS, f"{persona.voice.voice_id} via {persona.voice.model}")
        )

    provider = persona.avatar.provider
    if provider in (None, "", "none"):
        report.add(Result("avatar", Status.SKIP, "persona requests no avatar (voice-only)"))
    else:
        report.add(Result("avatar", Status.PASS, f"requests {provider}"))
    return persona


# ---------------------------------------------------------------------------
# vendors
# ---------------------------------------------------------------------------


async def check_anthropic(report: Report) -> None:
    section("anthropic")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        report.add(Result("reachable", Status.SKIP, "no key"))
        return
    try:
        from tutor_agent.core.protocol import canvas_tool_definitions
        from tutor_agent.providers.anthropic_llm import AnthropicLLM

        llm = AnthropicLLM(model="claude-sonnet-5", effort="low")
        started = time.perf_counter()
        saw_anything = False
        # Real tool definitions attached: a schema the API rejects fails here,
        # at startup, rather than on the learner's first question.
        async for _ in llm.stream_turn(
            system="Reply with the single word: ok",
            messages=[{"role": "user", "content": "ok"}],
            tools=canvas_tool_definitions(),
        ):
            saw_anything = True
        elapsed = (time.perf_counter() - started) * 1000
        if saw_anything:
            report.add(Result("turn with canvas tools", Status.PASS, timing_ms=elapsed))
        else:
            report.add(Result("turn with canvas tools", Status.FAIL, "stream produced no events"))
    except Exception as exc:
        report.add(
            Result(
                "turn with canvas tools",
                Status.FAIL,
                f"{type(exc).__name__}: {exc}",
                "check ANTHROPIC_API_KEY, or run `ant auth login`",
            )
        )


async def check_elevenlabs_tts(report: Report, persona) -> None:
    section("elevenlabs tts")
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key or persona is None or persona.voice is None:
        report.add(Result("synthesize", Status.SKIP, "no key or no voice"))
        return

    from tutor_agent.adapters.realtime import NUM_CHANNELS, SAMPLE_RATE
    from tutor_agent.core.audio import BYTES_PER_SAMPLE
    from tutor_agent.providers.elevenlabs import ElevenLabsTTS

    text = "Testing one two three."
    tts = ElevenLabsTTS(api_key=key, output_format=f"pcm_{SAMPLE_RATE}")
    try:
        started = time.perf_counter()
        first_chunk_ms: float | None = None
        audio = bytearray()
        aligned: list[str] = []
        odd_chunks = 0
        async for chunk in tts.synthesize_stream(
            text, voice_id=persona.voice.voice_id, model=persona.voice.model
        ):
            if chunk.audio and first_chunk_ms is None:
                first_chunk_ms = (time.perf_counter() - started) * 1000
            if len(chunk.audio) % BYTES_PER_SAMPLE:
                odd_chunks += 1
            audio.extend(chunk.audio)
            aligned.append(chunk.characters)

        report.add(
            Result(
                f"pcm_{SAMPLE_RATE} stream",
                Status.PASS,
                f"{len(audio)} bytes",
                timing_ms=first_chunk_ms,
            )
        )

        # The whole reason we call the API directly instead of via the plugin.
        joined = "".join(aligned)
        if joined == text:
            report.add(Result("character alignment", Status.PASS, "matches input exactly"))
        else:
            report.add(
                Result(
                    "character alignment",
                    Status.FAIL,
                    f"sent {len(text)} chars, aligned {len(joined)}",
                    "without alignment there is no cue timing and the canvas desyncs",
                )
            )

        # Confirms the splitter is load-bearing rather than theoretical.
        report.add(
            Result(
                "sample-boundary chunks",
                Status.PASS,
                f"{odd_chunks} of the stream's chunks ended mid-sample "
                f"({'handled by PcmStreamSplitter' if odd_chunks else 'none this run'})",
            )
        )

        duration_s = len(audio) / (SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE)
        if 0.5 <= duration_s <= 5.0:
            report.add(Result("decoded duration", Status.PASS, f"{duration_s:.2f}s of speech"))
        else:
            report.add(
                Result(
                    "decoded duration",
                    Status.FAIL,
                    f"{duration_s:.2f}s — implausible",
                    "the byte rate disagrees with the requested format; audio would "
                    "play at the wrong speed",
                )
            )

        if first_chunk_ms is not None and first_chunk_ms > BUDGET_MS * 0.5:
            report.add(
                Result(
                    "tts headroom",
                    Status.WARN,
                    f"{first_chunk_ms:.0f}ms to first audio leaves "
                    f"{BUDGET_MS - first_chunk_ms:.0f}ms for STT and the model",
                    "expected ~330ms; a slow result here means the budget will be tight",
                )
            )
    except Exception as exc:
        report.add(
            Result(
                "synthesize",
                Status.FAIL,
                f"{type(exc).__name__}: {exc}",
                "check ELEVENLABS_API_KEY and that the voice id exists on the account",
            )
        )
    finally:
        await tts.aclose()


async def check_elevenlabs_stt(report: Report) -> None:
    section("elevenlabs stt (scribe)")
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        report.add(Result("construct", Status.SKIP, "no key"))
        return
    try:
        import aiohttp

        from tutor_agent.adapters.worker import STT_LANGUAGE, STT_SAMPLE_RATE, VAD_OPTIONS

        # The websocket handshake, not just client construction: the API
        # validates VAD params at connect and rejects the whole socket with
        # 1008 invalid_request on a bad value (learned 2026-07-27, when a
        # vad_silence_threshold_secs below the 0.3s floor shipped and every
        # session came up deaf — while this check, then construction-only,
        # passed). Params mirror the plugin's _connect_ws, name for name:
        # VAD_OPTIONS keys pass through to the query string unchanged.
        query = "&".join(
            [
                "model_id=scribe_v2_realtime",
                f"audio_format=pcm_{STT_SAMPLE_RATE}",
                "commit_strategy=vad",
                f"language_code={STT_LANGUAGE}",
                *(f"{key}={value}" for key, value in VAD_OPTIONS.items()),
            ]
        )
        started = time.perf_counter()
        async with aiohttp.ClientSession() as http:
            ws = await http.ws_connect(
                f"wss://api.elevenlabs.io/v1/speech-to-text/realtime?{query}",
                headers={"xi-api-key": api_key},
            )
            first = await asyncio.wait_for(ws.receive(), timeout=10)
            await ws.close()
        opened = (
            first.type == aiohttp.WSMsgType.TEXT
            and first.json().get("message_type") == "session_started"
        )
        if not opened:
            detail = (
                first.json().get("message_type")
                if first.type == aiohttp.WSMsgType.TEXT
                else f"close {first.data} {first.extra or ''}".strip()
            )
            report.add(
                Result(
                    "realtime stt",
                    Status.FAIL,
                    f"handshake answered {detail!r}, not session_started",
                    "the API rejected the key or VAD_OPTIONS (adapters/worker.py)",
                )
            )
            return
        report.add(
            Result(
                "realtime stt",
                Status.PASS,
                f"session_started in {(time.perf_counter() - started) * 1000:.0f}ms, "
                f"finalizes after {VAD_OPTIONS['min_silence_duration_ms']}ms of silence",
            )
        )

        silence = VAD_OPTIONS["min_silence_duration_ms"]
        if silence > BUDGET_MS / 2:
            report.add(
                Result(
                    "vad headroom",
                    Status.WARN,
                    f"{silence}ms of the {BUDGET_MS}ms budget is spent waiting for silence",
                    "lower min_silence_duration_ms, at the cost of cutting off pauses",
                )
            )
    except Exception as exc:
        report.add(
            Result(
                "realtime stt",
                Status.FAIL,
                f"{type(exc).__name__}: {exc}",
                "uv sync --extra livekit",
            )
        )


# ---------------------------------------------------------------------------
# livekit — the leg nothing else exercises
# ---------------------------------------------------------------------------


async def check_livekit(report: Report, room_name: str) -> None:
    section("livekit room")
    needed = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")
    if not all(os.environ.get(n) for n in needed):
        report.add(Result("connect", Status.SKIP, "credentials incomplete"))
        return

    from livekit import api, rtc

    from tutor_agent.adapters.realtime import NUM_CHANNELS, SAMPLE_RATE, LiveKitAdapter
    from tutor_agent.core.cue import TimedAction

    token = (
        api.AccessToken(
            api_key=os.environ["LIVEKIT_API_KEY"],
            api_secret=os.environ["LIVEKIT_API_SECRET"],
        )
        .with_identity("preflight")
        .with_name("preflight")
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )
    report.add(Result("mint token", Status.PASS, f"room {room_name!r}"))

    room = rtc.Room()
    try:
        started = time.perf_counter()
        await room.connect(os.environ["LIVEKIT_URL"], token)
        report.add(
            Result(
                "connect",
                Status.PASS,
                f"sid {await room.sid}",
                timing_ms=(time.perf_counter() - started) * 1000,
            )
        )
    except Exception as exc:
        report.add(
            Result(
                "connect",
                Status.FAIL,
                f"{type(exc).__name__}: {exc}",
                "check LIVEKIT_URL and that the key/secret belong to that project",
            )
        )
        return

    try:
        source = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
        track = rtc.LocalAudioTrack.create_audio_track("preflight-voice", source)
        await room.local_participant.publish_track(
            track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        )
        report.add(Result("publish audio track", Status.PASS, f"{SAMPLE_RATE}Hz mono"))

        # Drive the real adapter, with the ragged chunk sizes a TTS stream
        # actually produces, straight into a live AudioSource.
        adapter = LiveKitAdapter(room=room, audio_source=source)
        for size in (1, 999, 4097, 12345):
            await adapter.send_audio(b"\x00" * size)
        await adapter.flush_audio()
        report.add(
            Result(
                "publish ragged pcm",
                Status.PASS,
                "odd-length chunks accepted by a real AudioSource",
            )
        )

        await adapter.stop_audio()
        report.add(Result("barge-in clear_queue", Status.PASS, "queue cleared"))

        await adapter.send_action(
            "t_preflight", TimedAction({"type": "new_section", "title": "preflight"}, 0, 0)
        )
        await adapter.cancel_turn("t_preflight", "preflight")
        report.add(
            Result(
                "data channel",
                Status.PASS,
                "canvas_action + cancel_turn published on the 'canvas' topic",
            )
        )
        print("      (open the cue-inspector on this room to see these frames arrive)")
    except Exception as exc:
        report.add(Result("publish", Status.FAIL, f"{type(exc).__name__}: {exc}"))
    finally:
        await room.disconnect()


# ---------------------------------------------------------------------------
# avatar
# ---------------------------------------------------------------------------


async def check_avatar(report: Report, persona) -> None:
    section("avatar vendor")
    provider = getattr(getattr(persona, "avatar", None), "provider", None)
    if provider in (None, "", "none"):
        report.add(Result("configured", Status.SKIP, "persona is voice-only"))
        return

    if provider == "lemonslice":
        key, ref_env = "LEMONSLICE_API_KEY", "LEMONSLICE_AVATAR_REF"
    elif provider == "simli":
        key, ref_env = "SIMLI_API_KEY", "SIMLI_FACE_ID"
    else:
        report.add(
            Result(
                "configured",
                Status.FAIL,
                f"unknown provider {provider!r}",
                "supported: lemonslice, simli, none",
            )
        )
        return

    if not os.environ.get(key):
        report.add(
            Result(
                key,
                Status.WARN,
                "unset — the session degrades to voice-only",
                f"set {key} to run with a face",
            )
        )
        return
    report.add(Result(key, Status.PASS, "set"))

    ref = persona.avatar.avatar_ref or os.environ.get(ref_env, "")
    if not ref:
        report.add(
            Result(
                "avatar ref",
                Status.WARN,
                f"neither persona.avatar_ref nor {ref_env}",
                f"set {ref_env} or put avatar_ref in the persona yaml",
            )
        )
    else:
        report.add(Result("avatar ref", Status.PASS, ref))

    if provider == "simli" and ref:
        try:
            import httpx

            from tutor_agent.providers.livekit_avatar import SimliConfig

            config = SimliConfig(api_key=os.environ[key], face_id=ref)
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.post(
                    f"{config.api_url}/compose/token",
                    json=config.to_payload(),
                    headers={"x-simli-api-key": config.api_key},
                )
            if response.status_code < 400:
                report.add(Result("simli session token", Status.PASS, "face id accepted"))
            else:
                report.add(
                    Result(
                        "simli session token",
                        Status.FAIL,
                        f"HTTP {response.status_code}: {response.text[:200]}",
                        "check SIMLI_API_KEY and that the face id exists",
                    )
                )
        except Exception as exc:
            report.add(Result("simli session token", Status.FAIL, f"{type(exc).__name__}: {exc}"))
    else:
        report.add(
            Result("handshake", Status.SKIP, "only completes inside a job context — run the worker")
        )


# ---------------------------------------------------------------------------


async def check_retrieval(report: Report) -> None:
    section("retrieval (sync plane)")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        report.add(
            Result(
                "configured",
                Status.SKIP,
                "DATABASE_URL unset — the tutor runs without indexed materials",
            )
        )
        return

    try:
        import asyncpg
    except ImportError:
        report.add(Result("driver", Status.FAIL, "asyncpg missing", "uv sync --extra postgres"))
        return

    try:
        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    except Exception as exc:
        report.add(
            Result("connect", Status.FAIL, f"{type(exc).__name__}: {exc}", "cd infra && make up")
        )
        return

    try:
        report.add(Result("connect", Status.PASS, dsn.rsplit("@", 1)[-1]))

        applied = await pool.fetchval(
            "SELECT count(*) FROM schema_migrations WHERE name = '0012_doc_chunks'"
        )
        if applied:
            report.add(Result("schema", Status.PASS, "0012_doc_chunks applied"))
        else:
            report.add(
                Result(
                    "schema",
                    Status.FAIL,
                    "doc_chunks migration not applied",
                    "cd infra && make migrate",
                )
            )
            return

        # The column width and EMBEDDING_DIM must agree or every INSERT fails.
        from tutor_agent.retrieval.embeddings import EMBEDDING_DIM

        dim = await pool.fetchval(
            """
            SELECT atttypmod FROM pg_attribute
            WHERE attrelid = 'doc_chunks'::regclass AND attname = 'embedding'
            """
        )
        if dim == EMBEDDING_DIM:
            report.add(Result("embedding width", Status.PASS, f"vector({dim})"))
        else:
            report.add(
                Result(
                    "embedding width",
                    Status.FAIL,
                    f"column is vector({dim}) but EMBEDDING_DIM is {EMBEDDING_DIM}",
                    "changing embedding model is a reindex, not a config flip",
                )
            )

        indexed = await pool.fetchval(
            "SELECT count(*) FROM doc_chunks WHERE deleted_at IS NULL AND embedding IS NOT NULL"
        )
        if indexed:
            report.add(Result("indexed chunks", Status.PASS, f"{indexed} searchable"))
        else:
            report.add(
                Result(
                    "indexed chunks",
                    Status.WARN,
                    "index is empty",
                    "uv run tutor ingest <file> --user <uuid> --upload <uuid>",
                )
            )

        if not os.environ.get("VOYAGE_API_KEY"):
            report.add(
                Result(
                    "embedder",
                    Status.WARN,
                    "VOYAGE_API_KEY unset — hashing fallback",
                    "retrieval will be keyword-ish, not semantic",
                )
            )
        else:
            report.add(Result("embedder", Status.PASS, "voyage"))
    finally:
        await pool.close()


CHECKS = ("env", "persona", "anthropic", "tts", "stt", "livekit", "avatar", "retrieval")


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--persona", default=os.environ.get("TUTOR_PERSONA", "ada"))
    parser.add_argument("--room", default="preflight")
    parser.add_argument(
        "--skip", action="append", default=[], choices=CHECKS, help="skip a check (repeatable)"
    )
    args = parser.parse_args()

    run = [c for c in CHECKS if c not in args.skip]
    report = Report()

    print("preflight — every leg of the live loop, in the order it runs")

    if "env" in run:
        check_env(report)
    persona = check_persona(report, args.persona) if "persona" in run else None
    if "anthropic" in run:
        await check_anthropic(report)
    if "tts" in run:
        await check_elevenlabs_tts(report, persona)
    if "stt" in run:
        await check_elevenlabs_stt(report)
    if "livekit" in run:
        await check_livekit(report, args.room)
    if "avatar" in run and persona is not None:
        await check_avatar(report, persona)
    if "retrieval" in run:
        await check_retrieval(report)

    counts = {s: sum(1 for r in report.results if r.status is s) for s in Status}
    print(
        f"\n{counts[Status.PASS]} passed, {counts[Status.WARN]} warned, "
        f"{counts[Status.FAIL]} failed, {counts[Status.SKIP]} skipped"
    )
    if report.failed:
        print("\nNot ready for a live session. Fix the ✗ lines above.")
        return 1
    print("\nReady. Start the worker:")
    print("    uv run python -m tutor_agent.adapters.worker dev")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
