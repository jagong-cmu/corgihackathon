# Personal AI Tutor — Project Context & Architecture

> **Purpose of this document.** This is the canonical context file for the repo. It explains what we are building, why each technology was chosen, how the subsystems fit together, and the rules any contributor — human or coding agent — must follow when extending the codebase. If you are a coding agent: read this fully before making changes, follow the schemas and conventions defined here exactly, and update this document when you make an architectural decision that isn't captured yet. Consider symlinking or copying this file to `CLAUDE.md` / `AGENTS.md` so agent tooling picks it up automatically.

**Status:** pre-MVP, architecture defined, prototypes exist for the analogy engine.
**Last updated:** July 2026 (v2 — Merge.dev promoted to integration backbone; Photon ambient channel layer added).

---

## 1. What we are building

A real-time AI personal tutor for adults (18+) with three pillars, in priority order:

1. **A personalized avatar tutor.** The user chooses who teaches them: a synthetic character, or — with that person's recorded consent — a real person in their life (their mom, their best friend). The tutor appears as a live, talking, expressive video avatar with a cloned or selected voice, and holds natural spoken conversation. This is the product's primary hook and differentiator.
2. **A live visual teaching layer.** Alongside the avatar, a whiteboard-style canvas where the tutor draws, writes, annotates, and spawns interactive, physically-correct animations personalized to the learner's interests (e.g., Newton's third law demonstrated with colliding basketballs because the learner loves basketball). Visuals are rendered from code and specs, never generated as video, so they appear instantly and are correct by construction.
3. **Deep personal context, powered by Merge.dev as the integration backbone.** The tutor learns from the user's own materials wherever they live — Google Drive, OneDrive, SharePoint, Box, Dropbox (Merge File Storage category), Notion, Confluence and other wikis (Merge Knowledge Base category), plus direct uploads — and can *act* on the user's tools mid-lesson via Merge Agent Handler (e.g., pull a specific file on demand, create study tasks in the user's task manager). Merge is a first-class architectural commitment, not a convenience: breadth of connected sources is part of the product promise ("your tutor knows your whole academic life"), and Merge is how we deliver that breadth without building N integrations.

**Channels.** The primary experience is the web app (avatar + canvas). A second, ambient layer — built on **Photon (photon.codes)** and its open-source Spectrum SDK — brings the same tutor to iMessage, SMS/RCS, WhatsApp, Telegram, and phone calls: spaced-repetition quizzes by text, photo-of-a-homework-problem Q&A, and voice-only tutoring calls. The ambient layer is deliberately phased after the core experience (§12), but the agent core must be built channel-agnostic from day one so this layer is an adapter, not a rewrite.

### What this is not

Not a video-generation product (no diffusion video in the live loop — see §6.1). Not a chat app with TTS bolted on (speech, avatar, and canvas are synchronized down to the word level). Not a content library (lessons are generated live from the learner's questions and materials; a small curated pre-rendered library exists only as a supplement).

### Working assumptions (revisit as needed)

The product targets startup-grade quality with MVP pragmatism: buy managed services where the market has commoditized (avatar rendering, TTS, transport, integrations, messaging delivery), build only what differentiates (the teaching canvas, the analogy engine, the sync protocol, the persona onboarding flow). Breadth is "academics plus professional skills," with academic subjects built first.

---

## 2. System architecture overview

```
┌────────────────── Browser client (Next.js) ──────────────────┐   ┌─────────────────────────────┐
│  Avatar video tile          tldraw canvas (whiteboard)       │   │ Ambient channels (Photon)    │
│  (LiveKit video track)      • agent-drawn shapes/annotations │   │  iMessage / SMS / WhatsApp / │
│                             • EquationShape, GraphShape,     │   │  Telegram / phone calls      │
│                             • SimulationShape (analogy eng.) │   │  via Spectrum SDK gateway    │
│                             • student drawing fed back       │   │  (/apps/messaging, TS)       │
└──────────┬──────────────────────────▲───────────────────────┘   └──────────────┬──────────────┘
           │ WebRTC A/V               │ canvas actions (JSON, data channel)       │ msgs/calls
┌──────────▼──────────────────────────┴─────────────────────────┐                 │
│                    LiveKit room (transport spine)              │                 │
└──────────┬──────────────────────────▲─────────────────────────┘                 │
           │                          │                                           │
┌──────────▼──────────────────────────┴──────────────┐  ┌──────────────────┐      │
│  Agent core (channel-agnostic tutor brain)          │  │ Avatar provider  │      │
│   Realtime adapter: STT (Scribe) → LLM → dual       │─▶│ (LemonSlice /    │      │
│   stream: speech→ElevenLabs Flash TTS / actions→DC  │au│ Simli / Tavus    │      │
│   Messaging adapter: text/image turns ◀─────────────┼──┼──────────────────┼──────┘
│   Tools: canvas actions + Merge Agent Handler (MCP) │  │ via LiveKit      │
└───────┬──────────────────────┬──────────────────────┘  │ avatar plugin    │
        │                      │ per-user MCP session     └──────────────────┘
        │              ┌───────▼───────────────────────────────────────────┐
        │              │ Merge Agent Handler (ACTION PLANE)                │
        │              │  live tool calls: fetch file on demand, search KB,│
        │              │  create/track study tasks (Ticketing category),   │
        │              │  connectors beyond unified categories; Security   │
        │              │  Gateway scans every tool input/output; full logs │
        │              └───────────────────────────────────────────────────┘
┌───────▼───────────┐  ┌───────────────────────────────────────────────────┐
│ Retrieval          │  │ Merge Unified API (SYNC PLANE)                    │
│  pgvector (MVP)    │◀─│  File Storage: Drive, OneDrive, SharePoint, Box,  │
│  → Moss (later,    │  │  Dropbox · Knowledge Base: Notion, Confluence, …  │
│  sub-10ms in-loop) │  │  Merge Link onboarding + Article/File Picker      │
└───────────────────┘  │  webhooks → ingestion workers → chunk/embed       │
                       └───────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────┐
│ Persistence: Postgres (+pgvector) · S3 blobs (photos, voice, consent,     │
│ asset packs, canvas snapshots) · fal.ai flux-schnell asset-pack jobs      │
└──────────────────────────────────────────────────────────────────────────┘
```

Two load-bearing decisions. First: **the avatar is a swappable plugin and the canvas is driven by data, not pixels** — the agent core owns all intelligence; every downstream system consumes its output streams. Second: **all third-party user-data access flows through Merge** — bulk context through the Unified API sync plane, live actions through Agent Handler — so adding a new source is configuration, not code.

---

## 3. Tech stack and rationale

**Transport & orchestration: LiveKit + LiveKit Agents (Python).** Industry-standard WebRTC infrastructure. Its avatar plugin layer supports 14+ providers behind one interface, which is exactly the vendor-swappability we need. The data channel carries our canvas action protocol.

**LLM (tutor brain): Anthropic Claude (primary)** behind a thin provider interface. Chosen for spatial/canvas reasoning quality (tldraw's agent template recommends it) and reliable structured tool output; Agent Handler ships native adapters for Anthropic tool schemas.

**STT: ElevenLabs Scribe v2 Realtime** (sub-150ms, 90+ languages). Deepgram is the fallback.

**TTS + voice cloning: ElevenLabs.** Flash v2.5 in the real-time loop (~75ms). Instant Voice Clone (1–2 min audio) standard; Professional Voice Clone (~30 min) premium. The expressive v3 model is not real-time — pre-rendered library content only.

**Avatar rendering: LemonSlice (default) or Simli via the LiveKit avatar plugin** — live avatar from a single photo, zero training, which makes persona onboarding a 30-second step. **Tavus** is the premium high-fidelity tier (~2 min consent footage, which suits the consent flow in §9 anyway). No provider hard-coding; select per-persona via config.

**Integrations: Merge.dev — the backbone (see §7 for the full design).** Two Merge products, two roles. *Merge Unified API* is the sync plane: the File Storage category (Google Drive, OneDrive, SharePoint, Box, Dropbox) and Knowledge Base category (Notion, Confluence, and peers) feed the RAG pipeline through one normalized data model, with Merge Link providing the user-facing auth flow and pickers for scoping. *Merge Agent Handler* is the action plane: a per-user MCP session that gives the live tutor governed, observable tool calls into hundreds of connectors — including reads the sync plane hasn't indexed yet and write actions like task creation. Merge manages auth, rate limits, deprecations, and permissions on our behalf.

**Ambient channels: Photon (Spectrum SDK, TypeScript).** One gateway service deploys the tutor to iMessage, SMS/RCS, WhatsApp, Telegram, Slack, and Discord from a single codebase, with phone-call support and interactive mini apps inside iMessage threads; Photon provides delivery infrastructure, observability, human-in-the-loop review, and opt-out compliance.

**Whiteboard: tldraw SDK**, starting from tldraw's official agent template (canvas state → simplified shape formats + screenshot → prompt → streamed JSON actions → editor operations). Production requires a tldraw license key.

**Simulations & widgets: Matter.js** (2D physics), **p5.js** (escape hatch), **KaTeX**, **Mafs / function-plot**, **recharts/d3**, **Sandpack/Pyodide** (later).

**Personalized assets: fal.ai running flux-schnell** (~$0.003/image) for themed sprite packs, generated by background jobs and cached; live generation is the narration-covered exception.

**Retrieval: pgvector for MVP → Moss** (usemoss.dev, sub-10ms real-time semantic search, LiveKit/Pipecat-native) when retrieval latency inside the voice loop becomes perceptible. Behind a `RetrievalProvider` interface.

**App & persistence: Next.js, Postgres (+pgvector), S3-compatible blob storage.**

**Pre-rendered library (supplement only): Manim / Motion Canvas / Remotion**; diffusion video (Veo/Kling) offline as a production tool with mandatory human review. Never in the live loop.

---

## 4. The real-time loop, end to end

A session turn works like this. The user speaks; Scribe streams the transcript to the agent core. The core assembles context: the persona definition, session memory, the current canvas state (BlurryShapes for the viewport plus IDs of anything the student selected or drew since last turn, plus a screenshot when visual detail matters), and retrieval results from the user's synced materials. The LLM responds with one interleaved stream containing speech segments and tool calls.

Speech segments go to ElevenLabs Flash over the streaming API, which returns audio plus character-level timestamps; the audio is routed to the avatar provider, which lip-syncs and publishes the video track into the LiveKit room. Canvas tool calls are validated against their Zod/JSON schemas, tagged with a cue time derived from the TTS timestamps of the words they belong to, and sent down the data channel. The client holds a cue queue keyed to audio playback time and applies each action to the tldraw editor exactly when its word is spoken. Invalid actions are dropped silently and logged — a missing arrow is invisible; a crashed canvas ends the lesson.

Merge Agent Handler tool calls follow a different rule because they leave our infrastructure: they are **never awaited synchronously inside a speech segment**. The model is prompted to emit them with a narration cover ("let me grab that problem set from your Drive…"), the call runs async, and the result lands in the next reasoning step. See §7.3.

Latency budget targets: user stops speaking → tutor audio begins ≤ 1.2s; canvas actions render at 0ms perceived cost; retrieval from the synced index ≤ 150ms in-loop; any operation that can exceed ~1s (Agent Handler calls, live asset generation, escape-hatch code) must be narration-covered.

### Sync protocol (data channel message format)

```jsonc
// Every canvas-bound message:
{
  "type": "canvas_action",
  "turnId": "t_0142",
  "seq": 7,                      // ordering within the turn
  "cueMs": 3480,                 // offset into this turn's audio; 0 = fire immediately
  "action": { /* one of the action schemas in §5.2 */ }
}
// Client → agent (student activity, sent between turns):
{
  "type": "student_event",
  "kind": "drew" | "selected" | "moved" | "sim_param_changed",
  "shapeIds": ["shape:abc"],
  "detail": { }
}
```

Rules: actions within a turn apply in `seq` order regardless of arrival order; a new turn's first action implicitly cancels any unfired cues from the previous turn (barge-in support); every action is idempotent where possible (prefer `set` semantics over `toggle`).

---

## 5. The whiteboard agent

Built on tldraw's agent template (`npm create tldraw@latest`, agent template). Keep its core pipeline and shape-simplification formats; replace its chat input with the voice loop; extend its action set and shapes as follows.

### 5.1 Custom shapes

`EquationShape` (KaTeX render, supports per-term highlight targets), `GraphShape` (Mafs/function-plot wrapper: functions, points, tangents, shaded regions, animatable parameters), `SimulationShape` (hosts an analogy-engine instance — see §6), `StepsShape` (worked-problem lines with one-by-one reveal), `MediaShape` (image/cached-clip playback with scrub control), `SourceShape` (renders an excerpt of a synced document — a slide, a Notion block — with provenance metadata so the tutor can teach directly *on top of the user's own materials*). All custom shapes must serialize cleanly into tldraw snapshots and summarize themselves into the FocusedShape context format so the model can "see" them.

### 5.2 Teaching action set (extends the template's stock drawing actions)

```ts
point_at({ target: shapeId | {x,y}, style: "laser" | "arrow", holdMs })
highlight({ target: shapeId | { shapeId, sub: "term:3" }, color })
write_steps({ x, y, lines: string[], reveal: "one_by_one" | "all" })
equation({ x, y, latex, id })
graph({ x, y, spec: GraphSpec, id })
spawn_sim({ x, y, spec: SimSpec, id })                 // §6
sim_control({ id, op: "play"|"pause"|"replay"|"speed", value? })
sim_update({ id, param, value })
show_source({ x, y, chunkId | mergeFileRef, region?, id })  // SourceShape
new_section({ title })                                  // camera to fresh board space
clear_region({ bounds })
camera({ op: "focus", target: shapeId | bounds })
```

Conventions the model is prompted with and validators enforce: the board is organized into sections (~800×600 logical units); placement is relative to the current section, never absolute pixel math across the whole board; prefer `new_section` over erasing (the board scrolls like a real lecture and doubles as the student's reviewable notes); every created shape gets a stable `id` the model can reference later.

### 5.3 Student → agent loop

Student drawings, selections, dropped images (e.g., a photo of a homework problem), and simulation-knob changes are sent as `student_event`s and folded into the next turn's context, with a viewport screenshot when the event is visual. Deictic references ("why is *this* negative?") resolve via the selected shape IDs. This two-way loop is a core product behavior, not an enhancement — preserve it in every refactor.

---

## 6. The analogy engine (personalized simulations)

### 6.1 Principle: render code, not pixels

Live visuals are computed by deterministic runtimes from small specs the LLM emits. Diffusion video is banned from the live loop for two reasons: latency (20–45s+ for a 5-second clip) and, worse for a tutor, **no physical correctness guarantee** — a generated clip can show wrong momentum transfer while looking plausible. In the analogy engine, force arrows are derived from computed impulses, so they are correct by construction. A working prototype of this pattern exists (`/prototypes/analogy-engine-v0.jsx`): spec → exact 1-D collision physics → themed render → engine events → narration cues.

### 6.2 Spec format

```jsonc
{
  "template": "collision_2body",        // must exist in the registry
  "theme": "basketball",                // resolves sprites via the asset pipeline
  "objects": [
    { "sprite": "basketball", "label": "Ball A", "mass": 0.62, "v": 4.2 },
    { "sprite": "basketball", "label": "Ball B", "mass": 0.62, "v": 0 }
  ],
  "params": { "restitution": 0.85 },
  "overlays": ["force_vectors", "slowmo_at_impact", "momentum_hud"],
  "beats": [ { "at": "impact", "say": "…narration cue text…" } ]
}
```

### 6.3 Template registry

Each template is one module exporting `{ id, schema (Zod), build(spec) → world, events, overlays, defaults }`. Adding a template must never require touching the engine core. Initial registry (subject-agnostic core, visually-strong subjects first): `collision_2body`, `projectile`, `inclined_plane`, `pendulum`, `distribution_sampler` (stats), `function_explorer` (calculus), `timeline`, `labeled_diagram`, `annotated_map`, `flow_diagram`. The `p5_sketch` escape hatch accepts LLM-written p5.js rendered in a sandboxed iframe for concepts no template covers; every escape-hatch use is logged, and recurring uses are promoted into proper templates.

### 6.4 Determinism (hard requirement)

Fixed timestep, seeded randomness, no wall-clock dependence. This makes replays exact, enables "rewind to just before the impact," lets the agent predict event timing for narration without executing anything, and makes demos reliable.

### 6.5 Theming / asset pipeline

At onboarding (and whenever interests change), a background job generates a sprite pack per interest via fal.ai flux-schnell (server-templated prompts only — user free text is mapped to a vetted interest taxonomy, never interpolated raw into image prompts), runs background removal, and caches to blob storage under `asset_packs/{userId}/{theme}/`. Spec `sprite` fields resolve pack-first, falling back to a built-in procedural sprite set (also the offline/dev default). Live one-off generation is allowed but must be narration-covered and is subject to the provider's safety filters plus our own prompt allowlist.

---

## 7. Context & actions — the Merge backbone

Merge is the single gateway for all third-party user data and actions. This is a deliberate architectural commitment: it converts "number of supported integrations" from an engineering cost into a configuration decision, and integration breadth is part of the product promise. Direct provider SDKs (Google, Notion, etc.) must not appear anywhere in this codebase; the only integration client is `/packages/integrations`, which wraps Merge.

### 7.1 Sync plane — Merge Unified API (bulk context for RAG)

Categories used: **File Storage** (Google Drive, OneDrive, SharePoint, Box, Dropbox) and **Knowledge Base** (Notion, Confluence, and the rest of the category as Merge expands it). Flow: during onboarding, the user authorizes sources through **Merge Link** embedded in our UI, using Merge's picker components (Article Picker for Knowledge Base; folder/file scoping for File Storage) so the user hand-picks exactly which folders, spaces, or pages the tutor may learn from — this is both the consent UX and our data-minimization mechanism. Merge syncs the scoped content into its normalized models (Files/Folders/Drives; Articles/Containers/Attachments); our ingestion workers consume Merge webhooks for deltas, pull content through the unified endpoints, chunk it, embed it, and upsert into the retrieval index with per-chunk provenance (`merge_linked_account`, `remote_id`, source URI). Deletions and permission changes propagate: when Merge reports a file removed or a linked account severed, all derived chunks are purged. Merge's permission/ACL models are recorded per chunk and enforced at query time, which matters the moment two people share materials (study groups, B2B later).

Why Unified API here rather than Agent Handler: bulk RAG needs *synced, normalized, webhook-fresh* data, not per-question API round-trips — retrieval must stay ≤150ms in-loop, which only a local index satisfies.

### 7.2 Action plane — Merge Agent Handler (live tools for the tutor)

The agent core opens a **per-user MCP session** with Agent Handler (tool-pack ID + registered-user ID); the exposed tool pack is curated by us, not "everything." Initial tool pack, in priority order: on-demand file fetch and search ("grab the practice midterm in my Drive I haven't synced"), live Knowledge Base search for content newer than the last sync, and **study-planner actions via the Ticketing category** — creating and tracking assignments/study tasks in whatever tool the user already uses (Asana, ClickUp, Jira, Trello, and peers), so "quiz me Thursday on chapters 4–6" becomes a real task in the user's own system. Agent Handler's connector catalog extends beyond the unified categories, giving us a growth surface (e.g., calendar or comms connectors) without new engineering. Every call passes through Merge's Security Gateway (input/output scanning) and lands in Merge's observability logs; we mirror call metadata into our own `tool_call_log` for product analytics. Auth for action-plane connectors also flows through Merge Link, appearing contextually the first time the tutor wants to use a tool the user hasn't connected.

### 7.3 Rules of engagement between the two planes

The sync plane answers "what does the tutor know" (fast, in-loop, ≤150ms). The action plane answers "what can the tutor do right now" (slower, governed, narration-covered, never awaited inside a speech segment). The model's prompt encodes this: prefer retrieval; reach for Agent Handler tools when the user references something not in the index or asks for an action; always narrate before a live call. Results from action-plane fetches are fed back through the same ingestion path so they join the index (learn-once semantics).

### 7.4 Growth paths this unlocks

Because the backbone is category-based, expansion is configuration: more File Storage and Knowledge Base providers as Merge adds them; a B2B corporate-learning offering later can join employee context through Merge's **HRIS** category (role, team, tenure → personalized upskilling) and file/KB access through the same planes we already run. None of this requires new integration code — which is precisely why Merge is the backbone.

### 7.5 Engineering hygiene

Merge is still behind our `SourceAdapter` / `ActionProvider` interfaces in `/packages/integrations` — not to hedge on the commitment, but to keep tests runnable offline (fixture adapters), keep direct-upload ingestion on the same code path, and keep the door open for sources Merge will never cover. Rate limits are per Linked Account on Merge's side; ingestion workers must respect Merge's sync-frequency semantics rather than hammering resync endpoints. Merge is a commercial B2B contract — treat it as a core infrastructure line item alongside LiveKit and ElevenLabs.

---

## 8. Ambient channel layer — Photon

The same tutor, reachable where the user already texts. Built as `/apps/messaging` (TypeScript) on Photon's **Spectrum SDK**, which deploys one agent codebase to iMessage, SMS/RCS, WhatsApp, Telegram, Slack, and Discord, with phone-call support and interactive mini apps inside iMessage threads; Photon provides the delivery infrastructure, per-line isolation, audit logs, human-in-the-loop review, and opt-out compliance.

What runs on it, in build order: session follow-ups and spaced-repetition quizzes ("3 quick questions from yesterday's calculus session" — as an iMessage mini app where supported, plain text elsewhere); photo Q&A (student texts a photo of a problem; the agent core answers with text plus a rendered image of worked steps); scheduling and nudges tied to study-planner tasks from §7.2; and voice-only tutoring calls (the realtime pipeline minus avatar and canvas, bridged over Photon's phone support — same brain, same persona voice).

Architecture rule: the messaging gateway is a **channel adapter over the same agent core** — it must contain no tutoring logic. Where the web channel renders canvas actions live, the messaging adapter renders them server-side: a headless tldraw/renderer worker executes the same action stream into a PNG attached to the message. Sessions are unified in the data model (§10): a text exchange and a web session share memory, so the tutor on Thursday's quiz remembers Tuesday's whiteboard. This layer is explicitly **phased after the core experience** (§12, Phase 6) — but the channel-adapter seam in the agent core is built in Phase 1, because retrofitting channel-agnosticism is a rewrite.

---

## 9. Persona system (the #1 product hook)

A persona = identity + face + voice + teaching style. Two creation paths:

**Synthetic characters (zero-friction default).** A curated library of designed characters with licensed/stock voices. No consent machinery. Users can customize style ("more Socratic," "more patient," "funnier").

**Real-person personas (the delightful upgrade).** The user sends the person a **consent link**. That person — never the user on their behalf — records a short consent statement, a voice sample (1–2 min for IVC), and a photo or, for the Tavus premium tier, ~2 minutes of video. Uploads of third-party photos/voices without this flow are rejected by design: persona creation only accepts media captured within the consent session. Public figures and celebrities are blocked (name/face matching at upload, and vendor-side policies also enforce this). Consent recordings are retained as records; personas are revocable by the person cloned at any time via their link.

Persona definition feeds the system prompt (personality, phrasing habits optionally learned from consented voice samples' transcripts), the ElevenLabs voice ID, and the avatar provider + avatar ID. Persona-specific data lives in `personas` and is joined at session start. Personas apply across channels: the voice on a Photon phone call is the same cloned voice as the web avatar.

---

## 10. Safety, legal, and content rules

Audience is 18+; enforce at signup (self-attestation minimum; stronger verification if distribution channels require it). Likeness consent is mandatory and non-negotiable per §9 regardless of user age — this is about the person being cloned, not the user. Comply with ElevenLabs/Tavus/LemonSlice terms on voice/face cloning. Standard LLM content moderation applies to tutor output on **all channels**; image-generation prompts are server-templated (no raw user text). Messaging channels add obligations Photon's platform helps with but does not remove: explicit opt-in before any outbound message, honored opt-outs (STOP), and applicable telecom rules (e.g., TCPA for texts/calls in the US) — outbound nudges are strictly user-configured, never marketing. We are not lawyers: before public launch, obtain legal review of right-of-publicity and deepfake statutes in target jurisdictions and of biometric-data handling (voiceprints and face data implicate laws like Illinois BIPA — design retention and deletion accordingly: delete raw voice/photo uploads after provider enrollment where feasible, honor deletion requests end-to-end including vendor-side voice/avatar deletion).

Data minimization for context sync is structural (§7.1): only user-picked scopes sync; chunk-level provenance enables full purge per source; Merge ACLs are enforced at query time.

---

## 11. Data model sketch

```
users(id, email, created_at, …)
interest_profiles(user_id, interests jsonb)              -- vetted taxonomy keys
personas(id, owner_user_id, kind synthetic|real, name, style jsonb,
         voice_provider, voice_id, avatar_provider, avatar_ref,
         consent_recording_uri nullable, consent_status, revoked_at nullable)
sessions(id, user_id, persona_id, channel web|imessage|sms|whatsapp|phone,
         started_at, ended_at, subject_hint)
turns(id, session_id, role, transcript, started_ms, audio_uri nullable)
canvas_snapshots(id, session_id, taken_at, tldraw_snapshot jsonb)
merge_linked_accounts(id, user_id, merge_account_token_ref, category
                      filestorage|knowledgebase|ticketing, provider, scope jsonb,
                      status, linked_at, severed_at nullable)
doc_chunks(id, linked_account_id nullable, upload_id nullable, remote_id,
           uri, chunk_ix, text, embedding vector, acl jsonb, meta jsonb)
asset_packs(id, user_id, theme, manifest jsonb, status)
sim_specs(id, session_id, turn_id, spec jsonb)           -- for replay/caching
tool_call_log(id, session_id, plane sync|action, connector, tool, status,
              latency_ms, merge_log_ref, at)
study_tasks(id, user_id, linked_account_id, remote_ticket_id, due_at, kind, meta jsonb)
channel_identities(id, user_id, channel, address, opt_in_at, opt_out_at nullable)
event_log(id, session_id, kind, payload jsonb, at)       -- incl. escape-hatch uses
```

---

## 12. Proposed repo structure & build phases

```
/apps
  /web            Next.js client: session UI, avatar tile, tldraw board, onboarding
  /agent          Python LiveKit Agents worker: channel-agnostic core + realtime adapter
  /messaging      TS Photon Spectrum gateway: channel adapters, headless canvas renderer
/packages
  /canvas-protocol   Shared TS types + Zod schemas for actions, specs, data-channel msgs
  /analogy-engine    Template registry, physics runtimes, overlays (framework-agnostic)
  /shapes            tldraw custom shapes (Equation, Graph, Simulation, Steps, Media, Source)
  /integrations      Merge sync-plane client, Agent Handler MCP client, SourceAdapter/
                     ActionProvider interfaces, fixture adapters for offline tests
  /ingestion         Webhook consumers → chunker → embedder → index upsert/purge
  /personas          Consent flow, provider adapters (elevenlabs, lemonslice, simli, tavus)
/infra              IaC, LiveKit config, DB migrations
/docs               This file, ADRs (docs/adr/NNN-*.md), template-authoring guide
/prototypes         analogy-engine-v0.jsx and future spikes
```

`canvas-protocol` is the single source of truth for every message and spec schema; the agent worker validates against it (mirrored via JSON Schema export) and clients apply only validated actions.

**Phase 0 — Whiteboard agent (text-driven).** tldraw agent template + teaching actions + Equation/Graph/Steps shapes; chat input for fast iteration. *Done when:* a typed question produces a correctly-laid-out worked example on the board.

**Phase 1 — Voice loop, channel-agnostic core.** LiveKit Agents worker with Scribe + Claude + Flash TTS (no avatar); data channel + cue queue; barge-in cancels unfired cues; the core exposes the channel-adapter seam (§8) even though only the realtime adapter exists. *Done when:* spoken question → spoken answer with board actions landing on the right words, ≤1.2s to first audio.

**Phase 2 — Analogy engine.** Port the v0 prototype into `SimulationShape` on Matter.js; 4 templates + registry + deterministic replay; engine events cue narration beats. *Done when:* "explain Newton's third law" yields the basketball collision with correct force arrows synced to speech, and slider changes re-run in <1s.

**Phase 3 — Personas + avatar.** ElevenLabs IVC flow, consent-link capture, LemonSlice via LiveKit avatar plugin, synthetic character library. *Done when:* a consented real-person persona teaches a full session, face and voice.

**Phase 4 — Merge sync plane.** Merge Link onboarding with pickers, File Storage + Knowledge Base sync, webhook-driven ingestion to pgvector with provenance and purge, retrieval in the loop, `show_source` teaching on the user's own slides. *Done when:* the tutor teaches from a synced syllabus using its notation, and disconnecting the source purges its chunks.

**Phase 5 — Merge action plane.** Agent Handler MCP session per user, curated tool pack (fetch/search + Ticketing study planner), narration-cover prompting, `tool_call_log`. *Done when:* mid-lesson, the tutor fetches an unsynced Drive file on request and creates a study task in the user's task manager.

**Phase 6 — Photon ambient layer.** Spectrum gateway, iMessage/SMS quizzes with headless canvas rendering, photo Q&A, opt-in/opt-out flows; voice-only phone tutoring after messaging is stable. *Done when:* a web session on Tuesday produces a Thursday iMessage quiz the tutor grades in-thread, with shared memory.

**Phase 7 — Hardening & upgrades.** fal.ai theming pipeline, p5 escape hatch, pre-rendered library, Moss retrieval if latency demands, Tavus premium tier, additional Merge categories (HRIS for B2B), session review exports.

Phases 0–2 are the demo core; 3 adds the hook; 4–5 add the moat; 6 adds ubiquity.

---

## 13. Conventions for coding agents

Validate everything at the boundary: no unvalidated JSON ever reaches the tldraw editor or a simulation runtime; on validation failure, drop, log to `event_log`, continue. Never block the voice loop: any operation that can exceed ~1s runs async with a narration cover pattern — this explicitly includes **every Merge Agent Handler call**. All third-party data access goes through `/packages/integrations` — importing a provider SDK (googleapis, @notionhq/client, etc.) anywhere is a review-blocking violation; Merge is the gateway. Enforce ACLs from `doc_chunks.acl` at retrieval time, never at ingestion time only. Keep vendors behind interfaces: `TTSProvider`, `AvatarProvider`, `RetrievalProvider`, `SourceAdapter`, `ActionProvider`, `LLMProvider`, `ChannelAdapter`. Channel adapters contain no tutoring logic — if you find yourself writing pedagogy in `/apps/messaging`, stop and move it to the core. Determinism in simulations is a test requirement: every template ships a golden-replay test (same spec + seed → identical event timeline). Prefer adding a template over special-casing the engine; prefer a new action over overloading an existing one; keep actions idempotent. All schema changes happen in `canvas-protocol` first, with a version bump and a migration note in `docs/adr/`. Do not introduce browser localStorage for session state (canvas state lives in tldraw snapshots + Postgres). Update this document when architecture changes; record significant decisions as ADRs.

### Known constraints cheat sheet

tldraw needs a production license key. ElevenLabs v3 is not real-time — Flash v2.5 in the loop. Avatar providers price per active minute (~$0.10–0.37 managed); pause the avatar stream when the user works solo on the board. Diffusion video: offline production only, human-reviewed. flux-schnell is Apache-2.0 (self-hostable later); FLUX dev weights are not commercial-free. Merge: commercial B2B contract, rate limits are per Linked Account, sync frequency is plan-dependent — respect it; Agent Handler sessions are per registered user + tool pack. Photon: Spectrum SDK is open source (self-hostable) with a managed cloud; messaging channels carry opt-in/opt-out obligations (§10); iMessage mini apps are iMessage-only — always define the plain-text fallback. COPPA machinery intentionally out of scope (18+ product) — do not add child-user flows without revisiting §10.

---

## 14. Open questions

Product name. Mobile app timeline (the Photon layer covers "on the go" earlier than a native app would). Pricing/packaging (per-minute avatar costs imply a capped-minutes subscription; texting quizzes are near-free and could be the retention engine of a cheaper tier). Whether CS tutoring (Sandpack/Pyodide) enters the initial template set. Which Ticketing providers to enable first in the study planner. Whether phone-call tutoring launches with Photon or waits for a dedicated telephony evaluation. Multi-party sessions (tutor + two students) — LiveKit supports it; product question only.
