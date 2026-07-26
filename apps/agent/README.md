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

## Not built yet

- `adapters/realtime.py` — the LiveKit worker. Needs keys to be worth writing.
- LemonSlice avatar adapter — goes behind `AvatarProvider` via the LiveKit
  plugin. `FakeAvatar` already exercises the lifecycle, including `pause()`,
  which matters because avatars bill per active minute.
- Consent capture flow — the spec enforces the invariant; nothing records a
  consent session yet.
- ACL enforcement at retrieval time. §13 requires filtering on
  `doc_chunks.acl` at query time, not only at ingestion — otherwise an upstream
  permission revocation doesn't take effect until the next re-sync. The
  `RetrievalProvider` protocol has no ACL parameter yet; add one before the
  first real pgvector implementation.
