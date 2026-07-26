# Live voice tutor — how to run it

The frontend now hosts a **live voice session** with the tutor agent: pick a
tutor from the **sidebar** (hamburger, top-left — the sidebar is the only
place tutors are picked), press *Start session* on the tutor card, and talk.
The tutor listens (STT), answers in its persona's cloned/library voice,
supports barge-in, and shows a talking-head avatar when the persona has one.
*Manage voice tutors* in the sidebar opens a builder for creating custom
tutors — identity, teaching style, few-shot exchanges, a voice (library pick
or clone), and an avatar.

**The whiteboard is now wired in.** The agent drives the Chalk board over the
`canvas` data topic with two actions: `present_visual` (a full VisualSpec,
every step hidden) and `reveal_step` (draw one step on). Each action carries a
`cueMs` derived from real TTS character timestamps; the client holds it in a
cue queue clocked off the tutor's own audio element (`src/live/cueBridge.ts`)
and applies it the moment the narration reaches it — so the drawing lands on
the words it belongs to, even if the stream stalls. The worker defaults to
this toolset; set `TUTOR_TOOLSET=canvas` to target the tldraw client instead.
The renderer itself (`src/render/`, `src/spec/`) is unchanged — the voice path
simply calls the `revealStep` seam the whiteboard always exposed.

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

**The fast way (the sidebar modal).** Hamburger → *Create a new tutor* → name,
webcam photo (or upload), ~10s voice recording (or upload) → **Create tutor**.
That one button runs the whole pipeline: a synthetic persona in the API, the
voice cloned on ElevenLabs (Instant Voice Clone), and the photo attached as
the LemonSlice avatar — the new tutor can immediately hold a live session with
their own face and voice. Anything that can't complete (API down, cloning
plan-gated) is reported in the modal and finishable later in the Tutors panel.

**The detailed way (the Tutors panel).**

1. *Manage voice tutors* (in the sidebar, right under *Create a new tutor*)
   → fill in the *New tutor* form. Few-shot exchanges are what make the
   persona stick — three or more real-sounding turns.
2. In the tutor's row: **Voice** → pick a library voice (preview first) or
   upload 1–2 min of clean speech to clone (plan-gated; the UI checks).
   *A session can't start for a tutor without a voice.*
3. Optional: **Avatar** → upload a photo (stored in the API's blob store; the
   worker hands the bytes to LemonSlice at session start, so no public URL is
   needed), or point at a Simli face ID / LemonSlice agent ID / public photo
   URL.
4. Close the panel — every tutor with a voice appears in the sidebar roster
   (the card carries no picker of its own). Picking one makes them *the*
   tutor (card, greeting, whiteboard); **Start session** brings them live in
   place. Seating a whiteboard-only tutor (like Trudy) shows a hint on the
   card pointing back to the sidebar.

## Degradation map (nothing here hard-fails)

| missing | behavior |
|---|---|
| LiveKit keys | Start button disabled with a setup hint |
| agent worker not running | you join the room; stage shows "waiting for the tutor agent to join" |
| persona API / Postgres | built-in tutors (`ada`, `coach-rios`, `nico`) only; builder panel explains. Nico — the default seat — has his persona in the store, so he lists but can't hold a session without it |
| avatar vendor key | voice-only session (worker logs it, keeps going) |
| mic permission denied | listen-only session with a visible warning |

## Deploying (Vercel)

The frontend's server needs are three tiny endpoints, shipped as Vercel
serverless functions in `api/live/` (same paths as the dev middleware, so the
client is identical in dev and prod):

- `POST /api/live/session` — LiveKit room + learner token (needs secrets)
- `GET /api/live/health` — is LiveKit configured on this deployment?
- `GET /api/live/tutors` — the sidebar's roster; override with a
  `TUTOR_LIBRARY` JSON env var, defaults in `api/_lib/tutorLibrary.ts`.
  Entries need `id` and `name`; everything else defaults safely —
  `hasVoice: false` (an un-voiced tutor can't be rung) and
  `avatarProvider: "none"` — and unexpected fields are dropped before
  serving, so nothing an operator puts in the env var reaches clients
  verbatim. An entry missing `id`/`name`, or invalid JSON, falls back to
  the default list.

Setup: in the Vercel project → Settings → Environment Variables, add
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (same values as
.env.local) and redeploy. **The agent worker still runs wherever you run it**
(a laptop is fine — it dials out to LiveKit Cloud), with `DATABASE_URL` set so
custom tutors resolve. Visitors anywhere → Vercel page → LiveKit Cloud room →
your worker joins with the persona named in the room metadata.

Not on Vercel? The self-hosted production server (`server/prod.ts`) serves
the same three endpoints, `/api/live/tutors` included. Run it with
`npm run build && npm start` (the Dockerfile / render.yaml deploy path does
the same). It listens on every interface by default; set a `HOST` env var
(e.g. `HOST=127.0.0.1`) to pin one. `npm run test:tutors` guards this whole surface — it checks the
client's fallback roster, the served library (including `TUTOR_LIBRARY`
edge cases), and boots the prod server on a loopback port to hit the route
live. No browser, no keys.

The Tutors *builder* panel needs the full local stack (apps/api + Postgres);
on Vercel it explains that instead of half-working.

## Known limitations (deliberate for now)

- No auth: the builder writes ownerless **synthetic** library personas (the
  only kind the schema allows without an owner — `self`/`real_person` need the
  consent machinery that isn't built).
- One persona per *room* (chosen at session start), which is the product
  behavior — but changing tutors means a new session.
- Voice/whiteboard sync is one-directional: the tutor draws, but the client
  doesn't yet send `student_event`s back (the token already grants
  `canPublishData` for it).
- Turn origins are inferred from the first frame's arrival (see
  `src/live/cueBridge.ts`), so every cue in a turn shares that frame's
  transport latency as bias — tens of ms in practice.
- Barge-in stops audio and unfired cues, but already-drawn steps stay on the
  board (there is no un-reveal); the next `present_visual` replaces the board.
