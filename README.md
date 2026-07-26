# Whiteboard — the visual/animation subsystem for an AI voice tutor

This repo is **one half** of an AI voice tutor: the **visual subsystem** that
draws explanatory graphics and animations on a whiteboard canvas, in sync with
the tutor's speech. The **voice half** (STT + a cloned TTS voice) is owned by a
separate teammate and is **out of scope** here — we define the interface, mock
it, and move on.

## Core principle

The LLM does **not** generate animation code or video at request time. It emits
a compact **Visual Spec (JSON)**. A deterministic client-side renderer
interprets that spec and **plays** a draw-on animation. "Live whiteboard
drawing" is a **render-layer** effect (staggered reveal, SVG stroke-dashoffset,
library transitions) — never a generation-layer effect. This keeps the first
visual on screen in ~1–2s regardless of generation latency.

The **Visual Spec is the module boundary** with the voice teammate: the shared
LLM emits `spokenText` **and** `visualSpec` from the same turn. Their TTS
consumes the text; this renderer consumes the spec. See
[`src/spec/visualSpec.ts`](src/spec/visualSpec.ts) — the most important file in
the repo — and its zod validator in
[`src/spec/validate.ts`](src/spec/validate.ts).

## Two render tracks

1. **Deterministic** (`mafs` + `katex`) — real math: function plots, tangents,
   vectors, number lines. Reliable core, built first.
2. **Freeform** (authored **Trudy** corgi SVG rig + `animejs`) — analogy/mascot
   explanations. Home of the hero demo.

## Run it

```bash
npm install
npm run dev        # Vite dev server (Phase 1: hardcoded specs)
npm run test:spec  # validate the spec contract + math evaluator (no browser)
```

## Build order / phase status

- **Phase 0 — Scaffold + spec contract** ✅ `VisualSpec` type, zod validator, KaTeX fallback.
- **Phase 1 — Test UI + Track 1 slice** ✅ Tutor shell (person-left / whiteboard-right); hardcoded `function_plot` draws on + animated tangent; mocked reveal cues + `revealStep`.
- **Phase 2 — Live LLM output** ✅ `POST /api/turn` (Anthropic SDK, model `claude-opus-4-8`) returns `{ spokenText, visualSpec }`; validated server-side with the shared zod schema, retry-once, then `equation` fallback. Ask bar in the UI drives the whiteboard live. Falls back to an offline mock when `ANTHROPIC_API_KEY` is unset.
- **Phase 3 — Merge / RAG** ✅ Mandated content-body check first (logs loudly + local-upload fallback when Merge creds absent); then extract (pdf/docx/pptx/txt) → chunk → embed → store (cached by content hash) → top-k retrieval → grounds the turn. Pluggable embeddings (local lexical default; OpenAI when keyed). Verified end-to-end via `npm run test:rag` + a live grounded turn.
- **Phase 4 — Trudy rig + freeform renderer** ✅ Component-based, CSS-driven Trudy SVG rig (poses: idle/wave/point/cheer; expressions: neutral/happy/think; breathing/blink/tail idle life). `FreeformScene` reveals authored beats in sync with the narration. Trudy is also the persistent tutor presence in the shell.
- **Phase 5 — Corgi/Trudy hero demo** ⬜ Merge-grounded Trudy scene synced via mocked cues. (All the pieces — RAG grounding, live turn, freeform Trudy — work independently; the purpose-built showcase isn't assembled yet.)
- **Phase 6 — Polish + `vector_diagram` + `number_line`** 🟡 Both new render primitives built, validated (zod + `test:spec`), wired into the LLM prompt + offline mocks, and viewable as scenes: `vector_diagram` (Mafs, grow-on vectors + resultant) and `number_line` (bespoke SVG, draw-on axis + interval band + open/closed points). UI design polish is ongoing; `geometry` primitive still to come.

## Guardrails

- The spec is validated (zod) before every render; invalid/unknown → KaTeX
  fallback, **never a white screen**.
- Generation ≠ render: the LLM only emits the JSON spec.
- Never block speech on a visual; `spokenText` emits immediately.
- Voice stays mocked behind `revealStep(stepId)` (see
  [`src/voice/voiceInterface.ts`](src/voice/voiceInterface.ts)).
- No `localStorage`; state in memory / backend only.

## Project structure

```
src/
  spec/            VisualSpec type, zod validator, example specs   ← the contract
  render/          WhiteboardRenderer (router) + track renderers
    tracks/        FunctionPlot, VectorDiagram, NumberLine (Track 1),
                   FreeformScene (Track 2), EquationFallback (guardrail)
    hooks/         useDrawSequence (reveal orchestration)
    mathfn.ts      safe single-variable function evaluator
  mascot/          Trudy SVG rig (CSS-driven poses + expressions)
  voice/           voice module interface + mock timer driver
  ui/              TutorShell test harness (person-left / whiteboard-right)
server/            LLM / Merge / RAG stubs (Phase 2/3)
scripts/           testSpec.ts — headless contract self-test
```
