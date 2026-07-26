# Chalk — an AI voice tutor that draws while it talks

You talk to it. It talks back in a cloned voice, and it works the problem on a
whiteboard while it speaks — the arrow lands on the term at the moment it says
"this one".

The board is not a recording and not a video. The model emits **teaching
actions** as it generates speech, each one anchored to the words it belongs to,
and the client applies them against the audio's playback position. That is why
the timing holds.

```
        ┌──────────── browser (this repo's root) ─────────────┐
mic ───▶│  LiveKit room                                        │
        │    ├── audio  ◀── the tutor's voice (and the clock)  │
        │    ├── video  ◀── the avatar, when the persona has one│
        │    └── data   ◀── canvas_action / cancel_turn        │
        │                      │                               │
        │              cue queue (keyed to playback position)  │
        │                      ▼                               │
        │              board reducer ──▶ shapes on screen      │
        └──────────────────────────────────────────────────────┘
                               ▲
                    ┌──────────┴───────────┐
                    │  agent worker (Python)│  STT ▸ Claude ▸ TTS
                    │  apps/agent           │  + cue timing
                    └──────────┬───────────┘
                               │
                    ┌──────────┴───────────┐        ┌──────────────┐
                    │  FastAPI  apps/api   │───────▶│  Postgres    │
                    │  sessions, materials │        │  + pgvector  │
                    └──────────────────────┘        └──────────────┘
```

## One contract, one brain, one index

Three things are deliberately singular. Each was two, briefly, and each
duplicate was worse than the thing it duplicated.

**One contract.** `@tutor/canvas-protocol` defines the 12 teaching actions and
the data-channel envelopes. The agent builds its Claude tool definitions from
it; the browser validates every inbound frame against it; both sides test
against the same golden fixtures in `packages/canvas-protocol/test/fixtures/`.
Changing the protocol breaks both sides at once, which is the point.

**One brain.** The tutor's turns happen in exactly one place — `TutorSession` in
`apps/agent`. There is no LLM call in the browser and none in any HTTP handler.

**One index.** Uploaded documents are extracted, chunked, embedded, and stored
in `doc_chunks` by the API; the worker queries that same table in-loop with the
learner's ACLs applied per query. Both processes must pick the same embedder —
see the note in `apps/api/src/tutor_api/retrieval.py`.

## Run it

Four processes. The first two are enough to see the board fill in.

```bash
# 1. Postgres + pgvector, and the schema
cd infra && make up && cd -

# 2. The API: session tokens and the materials index
cd apps/api && uv sync
set -a && . ../../.env.local && set +a
export DATABASE_URL=postgres://tutor:tutor@localhost:5432/tutor
uv run tutor-api                       # :8000

# 3. The canvas client
npm install && npm run dev             # :5173, proxies /api to :8000

# 4. The voice agent (needs real keys — see apps/agent/README.md)
cd apps/agent && uv sync --all-extras
set -a && . ../../.env.local && set +a
uv run python scripts/preflight.py     # ~1 cent, checks every leg
uv run python -m tutor_agent.adapters.worker dev
```

Open http://localhost:5173, press **Start a lesson**, and talk.

Without step 4 the app still connects and waits — useful for working on the
board, because you can replay a recorded lesson into the room instead:

```bash
npm run replay -w @tutor/cue-inspector -- --fixture worked-quadratic --room <room>
```

The room name is shown in the UI once you connect. Join the room *before*
starting the replay: a client that arrives mid-turn missed that turn's actions,
the same as a person walking in halfway through a sentence.

No LiveKit project? `livekit-server --dev` works with the placeholder keys in
`.env.local`. In Docker, pass `--node-ip 127.0.0.1` and publish `7882/udp`, or
the browser's ICE negotiation fails against a container-internal address.

## What runs where

| Path | What it is |
|---|---|
| `src/` | The canvas client. `live/` is the transport and cue queue, `board/` is the reducer and the shape renderers. |
| `apps/agent/` | The tutor. Persona, cue timing, STT/LLM/TTS/avatar providers, the LiveKit worker. |
| `apps/api/` | The only HTTP server: personas, voices, session tokens, materials. |
| `packages/canvas-protocol/` | The contract. Schemas, tool definitions, golden fixtures. |
| `infra/` | Postgres schema as forward-only SQL migrations. |
| `tools/cue-inspector/` | Throwaway harness for measuring cue drift against real audio. |

## Timing is the product

`cueMs` on every action is an offset into that turn's audio, derived from the
TTS character timings of the words the action accompanies. The client holds each
action until `HTMLAudioElement.currentTime` reaches that offset — never a
`setTimeout`, because a stalled audio track freezes playback while wall time
sails on, and every remaining action would fire into silence.

The UI shows live drift. Under 50ms is imperceptible; past 150ms the action is
landing on the wrong words. `tools/cue-inspector` exists to tell you which side
of the wire the drift came from.

## Guardrails

- **An invalid frame is dropped, never thrown.** A missing arrow is invisible; an
  exception on the render path ends the lesson. `safeParseAgentMessage` is the
  only way a frame enters the client.
- **Barge-in stops audio *and* the board.** Stopping cues alone gives you the
  worst version: the board freezes and the tutor talks over the learner.
- **ACLs are enforced at query time**, never at ingestion time only. One SQL
  predicate, in `retrieval/pgvector.py`, shared by search and by `show_source`.
- **Consent is enforced twice** for a cloned persona — a pydantic validator that
  refuses to construct one, and a CHECK constraint that refuses to store one.
- **Degrading is normal.** No database, no avatar, no microphone, and no
  retrieval index are each a smaller product rather than a broken one, and the
  UI says which one you are in.

## Tests

```bash
npm test                                   # board reducer, cue queue, evaluator
npm test -w @tutor/canvas-protocol         # the contract + golden fixtures
cd apps/agent && uv run pytest             # 312 tests, fully offline
cd apps/api   && uv run pytest             # needs Postgres; skips without it
```

The board reducer suite replays the same fixture files the agent asserts its
emitter produces. That shared artifact is how the two halves were built
independently and still met.

## Not built

- **The analogy engine (§6).** `spawn_sim` renders an honest placeholder that
  reflects the spec and responds to `sim_control` — it does not simulate.
- **Merge.** The sync plane's storage and query half exists; nothing calls Merge
  yet. `tutor ingest` and the upload endpoint stand in for the ingestion worker.
- **Auth.** `X-User-Id` names the learner. It is a development stub, and the §10
  18+ attestation gate is not enforced.
- **Consent capture.** The invariant is enforced; nothing records a session yet.
