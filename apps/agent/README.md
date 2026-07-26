# tutor-agent

The channel-agnostic tutor brain: persona, cue timing, and the realtime voice loop.

**Everything here runs offline.** No API keys, no network. The fakes emit
deterministic synthetic timestamps through the same code path the real
providers use, so the whole loop is testable today.

```bash
uv sync
uv run pytest              # 75 tests
uv run tutor personas
uv run tutor demo ada      # scripted turn + cue timeline
uv run tutor show ada      # the compiled system prompt
```

## Layering

```
adapters/    realtime (LiveKit), later messaging (Photon).
             NO tutoring logic — adapters move bytes.
core/        TutorSession, cue timing, action validation. All intelligence.
             Knows nothing about WebRTC or SMS.
providers/   Vendor adapters behind Protocols, plus offline fakes.
persona/     Who the tutor is.
```

The seam in `core/channel.py` exists in Phase 1 even though only the realtime
adapter is built, because retrofitting channel-agnosticism is a rewrite (§8).
`TestChannelAgnosticism` asserts the same core produces the same action stream
on a voice channel and a text channel.

## Personas

A persona is not a paragraph of prose. Prose gets you a generic tutor wearing
someone's voice. Three things carry mannerism, in order of impact:

1. **`few_shot`** — 3-8 real exchanges. Does most of the work. The model
   imitates the *shape* of the turns: length, rhythm, where they break off.
2. **`never_does`** — kills default assistant tics. "Great question!" is the
   single loudest tell that you're talking to a chatbot.
3. **`pedagogy.on_wrong_answer`** — wrong answers are where character shows.

Everything else (`verbosity`, `warmth`, `catchphrases`, `fillers`) is a dial
compiled into explicit prompt constraints by `persona/prompt.py`.

```bash
cp personas/self-clone.template.yaml personas/jonathan.yaml
$EDITOR personas/jonathan.yaml
uv run tutor show jonathan
```

### Consent is enforced in the type system

`PersonaSpec` **refuses to construct** a `kind: real_person` persona without a
granted consent record whose media was captured inside the consent session
(§9). Not a UI check — a validator, so no code path can route around it.

| `kind` | Consent required |
|---|---|
| `synthetic` | None. Designed character, licensed voice. |
| `self` | None — you're the data subject. Deletion still cascades to the vendor. |
| `real_person` | Granted + captured in-session + not revoked, or it won't load. |

## Cue timing

The mechanism behind "actions land on the right words":

1. Claude streams text and `tool_use` blocks **in order**. As we consume the
   stream, each tool call records how many characters of speech had accumulated
   when it opened.
2. ElevenLabs returns character-level timings aligned to the original input
   text, so that offset maps almost directly to a time.
3. `TurnTimeline.resolve()` anchors **forward** to the next word start.

The forward anchor matters. The model is prompted to emit an action
*immediately before* the words it accompanies:

```
correct:   [highlight] "See this term? That's the one that flips."
wrong:     "See this term? That's the one that flips." [highlight]
```

Anchoring backward fires every action a beat late. `VOICE_AND_CANVAS_RULES`
puts this in the system prompt; `TestAnchoring` locks the behavior.

Three traps, all covered by tests: word-boundary snapping (don't fire mid-word),
per-segment time offsets (segment 2's timestamps start at its own zero), and
actions past the end of speech (fire at the end — a late action is recoverable,
a missing one isn't).

## Model configuration

Default is `claude-sonnet-5` at `effort: "low"` — near-Opus reasoning at the
latency the 1.2s budget actually needs. Swap to `claude-opus-5` for offline
evaluation or pre-rendered library content, where latency doesn't bind.

**Don't disable thinking to save latency.** On Opus 5, `thinking: disabled` has
a failure mode where a tool call gets written into the visible response text
instead of emitted as a `tool_use` block — the turn succeeds, no error, and the
canvas action silently never fires. In this product that reads as "the tutor
said it was drawing an arrow and didn't." Lower `effort` instead; it's the
cheaper lever anyway.

## Wiring real providers

```bash
uv sync --extra anthropic --extra elevenlabs
export ANTHROPIC_API_KEY=...   # or: ant auth login
export ELEVENLABS_API_KEY=...
```

`AnthropicLLM` owns the tool-result round trip internally. Canvas actions are
fire-and-forget, but the API still needs a `tool_result` per `tool_use` before
the turn continues — so the provider acks each one with a stub immediately and
yields the core a flat ordered event stream. A canvas action never blocks on the
client, and `TutorSession` stays free of Anthropic-shaped plumbing.

Merge Agent Handler tools (Phase 5) must **not** be acked this way. They leave
our infrastructure, can exceed a second, and must be narration-covered (§7.3).

## Going live

Everything above runs offline. The live loop adds four vendors and a room, and
the failure modes there are not the ones the fakes produce — an in-memory
adapter accepts any byte string, so the suite passed for a long time with a
`send_audio` that would raise on the first odd-length chunk ElevenLabs sent.

Check every leg before spending a session debugging one:

```bash
set -a && . ../../.env.local && set +a
uv run python scripts/preflight.py        # ~1 cent, exits non-zero if not ready
uv run python -m tutor_agent.adapters.worker dev
```

Preflight walks the loop in the order it runs: env (including "is this still the
`livekit-server --dev` placeholder key"), persona, a real Claude turn with the
real tool definitions attached, a real TTS stream checked for character
alignment and plausible duration, the STT constructor and its VAD budget, an
actual LiveKit connect + publish + data-channel round trip, the avatar vendor
handshake, and the retrieval index. WARN means degraded but usable; FAIL means
don't start.

Set `TUTOR_METRICS_PATH=run.jsonl` and every turn appends its own latency
breakdown — STT finalization, model-to-first-audio, and the total against the
1200ms budget, separated so a regression points at a subsystem.

### Barge-in is audio, not just cues

`cancel_turn` stops canvas actions, which the client controls. Audio has already
left for the transport's playout buffer and the avatar's queue, so `barge_in()`
also calls `channel.stop_audio()` and `avatar.interrupt()`. Skipping that half
produces the worst version of the feature: the board freezes and the tutor keeps
talking over the learner.

`interrupt()` and `pause()` are separate methods on `AvatarProvider` on purpose.
The first is latency-critical and fires on every barge-in; the second is the
per-minute cost lever. Conflating them means one of the two is always wrong.

## Retrieval (§7.1, the sync plane)

`RetrievalProvider.search` takes a `Principal`, not a bare `user_id`:

```python
Principal(user_id="...", groups=frozenset({"g:cs101"}))
```

That is what makes §13's "enforce ACLs at retrieval time, never at ingestion
time only" implementable. Ownership is necessary and never sufficient; a chunk
in `principals` mode must overlap the requester's groups, so an empty group set
matches nothing rather than everything. The filter lives in one place —
`_SEARCH_SQL` in `retrieval/pgvector.py` — and `test_retrieval_pg.py` proves it
by deleting a group and asserting the chunk stops matching on the *next query*,
with no resync.

```bash
uv sync --extra postgres --extra embeddings
cd ../../infra && make up && cd -
export DATABASE_URL=postgres://tutor:tutor@localhost:5432/tutor

uv run tutor chunk notes.md                              # no database needed
uv run tutor ingest notes.md --user <uuid> --upload <uuid>
uv run tutor ask "what's on the midterm" --user <uuid>   # prints the 150ms budget
```

Embeddings default to `HashingEmbeddings`, which is lexical rather than
semantic — enough that a test asserting "the syllabus chunk ranks first" is
testing something, and enough for a local demo. Set `VOYAGE_API_KEY` for real
retrieval. `EMBEDDING_DIM` mirrors `vector(1024)` in migration 0012; changing
the embedding model is a reindex, not a config flip, and preflight checks the
two agree.

The integration tests need a database and are skipped without one:

```bash
TUTOR_TEST_DATABASE_URL=$DATABASE_URL uv run pytest tests/test_retrieval_pg.py
```

## Who the learner is

The worker does not decide. `POST /session` on the API signs the learner's id
into the join token's participant metadata, and `LearnerIdentity.parse` reads it
off the participant LiveKit hands us. That is what makes it safe to pass
straight to the retrieval ACL filter — a browser that edits its own copy simply
fails to connect.

Two consequences, both deliberate:

- The session is built **after** a participant joins, not at `entrypoint`. The
  persona comes from the same metadata and the system prompt is built from the
  persona, so there is nothing to construct until someone is in the room.
- A participant with no id in its token gets a session with **retrieval
  disabled**, not a session scoped to a default id. Falling back to a shared
  identity is how one learner's documents end up in another's context.

## Not built yet

- Merge itself. The sync plane's *storage and query* half is built —
  `merge_linked_accounts`, provenance, purge-on-sever — but nothing calls Merge:
  no Link onboarding, no webhook consumers, no delta handling. `tutor ingest`
  and the API's upload endpoint stand in for the ingestion worker.
- Merge Agent Handler (§7.2, the action plane). Deliberately not behind
  `RetrievalProvider` — it is slow, governed, and narration-covered, and putting
  the two behind one interface is how the fast path ends up awaiting the slow
  one.
- Consent capture flow — the spec enforces the invariant; nothing records a
  consent session yet.
- The analogy engine (§6). `spawn_sim` reaches a client that renders the spec
  faithfully and responds to `sim_control`/`sim_update`, but nothing simulates.
