# Live voice tutor — how to run it

The frontend now hosts a **live voice session** with the tutor agent: pick a
tutor on the left of the desk, press *Start session*, and talk. The tutor
listens (STT), answers in its persona's cloned/library voice, supports
barge-in, and shows a talking-head avatar when the persona has one. The
**Tutors** button in the header opens a builder for creating custom tutors —
identity, teaching style, few-shot exchanges, a voice (library pick or clone),
and an avatar.

**Deliberately out of scope:** the whiteboard. The agent also emits canvas
actions on the `canvas` data topic; the client ignores them. Speech-synced
drawing is a separate project — nothing under `src/render/`, `src/spec/`, or
`src/voice/` changed.

## How the pieces connect

```
browser (src/live/*) ── POST /api/live/session ──> vite dev server (server/live.ts)
    │                                                creates LiveKit room,
    │                                                metadata = {persona, owner},
    │                                                mints learner token
    ├── joins room, publishes mic, plays tutor audio + avatar video
    │
agent worker (apps/agent …/adapters/worker.py)
    reads room metadata -> loads persona (Postgres first, YAML fallback)
    runs STT -> Claude -> TTS, optionally hands audio to Simli/LemonSlice
    │
tutors panel (src/ui/TutorsPanel.tsx) ── /tutor-api proxy ──> apps/api (FastAPI)
    persona CRUD + ElevenLabs voice library/cloning, stored in Postgres
```

## Keys (`.env.local` at the repo root, gitignored)

| var | needed for |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | any live session. Use LiveKit **Cloud** if you want avatars — the vendors dial into the room from their side and can't reach a local `livekit-server --dev`. |
| `ANTHROPIC_API_KEY` | the tutor's brain (agent worker) |
| `ELEVENLABS_API_KEY` | the tutor's voice + STT (worker), voice library/cloning (API) |
| `DATABASE_URL` | custom tutors (API + worker lookup), e.g. `postgres://tutor:tutor@localhost:5432/tutor` |
| `SIMLI_API_KEY` / `LEMONSLICE_API_KEY` | avatars (optional — missing key degrades to voice-only) |
| `VOYAGE_API_KEY` | semantic retrieval (optional) |

## Run it (four processes)

```bash
# 1. Postgres + migrations + curated personas (only needed for CUSTOM tutors;
#    skip it and the built-in YAML tutors still work end to end)
cd infra && make up && make seed && cd -

# 2. The persona API (port 8000; the frontend proxies /tutor-api -> here)
cd apps/api && uv sync && set -a && . ../../.env.local && set +a \
  && uv run python -m tutor_api

# 3. The voice agent worker
cd apps/agent \
  && uv sync --extra livekit --extra anthropic --extra elevenlabs --extra db \
  && set -a && . ../../.env.local && set +a \
  && uv run python scripts/preflight.py     # optional, ~1 cent: checks every leg
uv run python -m tutor_agent.adapters.worker dev

# 4. The frontend
npm install && npm run dev                  # http://localhost:5173
```

## Creating a custom tutor

1. **Tutors** (header) → fill in the *New tutor* form. Few-shot exchanges are
   what make the persona stick — three or more real-sounding turns.
2. In the tutor's row: **Voice** → pick a library voice (preview first) or
   upload 1–2 min of clean speech to clone (plan-gated; the UI checks).
   *A session can't start for a tutor without a voice.*
3. Optional: **Avatar** → Simli face ID, or a LemonSlice agent ID / public
   photo URL. (A publicly reachable URL — the vendor fetches it; photos
   uploaded to the API's blob store aren't reachable from outside yet.)
4. Close the panel, pick the tutor in the stage dropdown, **Start session**.

## Degradation map (nothing here hard-fails)

| missing | behavior |
|---|---|
| LiveKit keys | Start button disabled with a setup hint |
| agent worker not running | you join the room; stage shows "waiting for the tutor agent to join" |
| persona API / Postgres | built-in tutors (`ada`, `coach-rios`) only; builder panel explains |
| avatar vendor key | voice-only session (worker logs it, keeps going) |
| mic permission denied | listen-only session with a visible warning |

## Known limitations (deliberate for now)

- No auth: the builder writes ownerless **synthetic** library personas (the
  only kind the schema allows without an owner — `self`/`real_person` need the
  consent machinery that isn't built).
- One persona per *room* (chosen at session start), which is the product
  behavior — but changing tutors means a new session.
- Voice/whiteboard synchronization is not wired; that's the canvas-protocol
  client work tracked in TODOS.md on the merge branch.
