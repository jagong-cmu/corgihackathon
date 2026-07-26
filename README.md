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
`src/spec/visualSpec.ts` — the most important file in the repo — and its zod
validator in `src/spec/validate.ts`.

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

Each demo is directly linkable: `/?demo=fn`, `/?demo=trudy`, `/?demo=broken`.

## Build order / phase status

- **Phase 0 — Scaffold + spec contract** ✅ `VisualSpec` type, zod validator, KaTeX fallback.
- **Phase 1 — Test UI + Track 1 slice** ✅ Tutor shell (person-left / whiteboard-right); hardcoded `function_plot` draws on + animated tangent; mocked reveal cues + `revealStep`.
- **Phase 2 — Live LLM output** ⬜ swap hardcoded spec for `POST /api/turn` → `{ spokenText, visualSpec }`.
- **Phase 3 — Merge / RAG** ⬜ content-body check first, then extract→chunk→embed→store + top-k retrieval.
- **Phase 4 — Trudy rig + freeform renderer** ⬜ component-based SVG rig, animejs pose/expression states.
- **Phase 5 — Corgi/Trudy hero demo** ⬜ Merge-grounded, synced via mocked cues.
- **Phase 6 — Polish + `vector_diagram` + `number_line`** ⬜.

## Guardrails

- The spec is validated (zod) before every render; invalid/unknown → KaTeX
  fallback, **never a white screen**.
- Generation ≠ render: the LLM only emits the JSON spec.
- Never block speech on a visual; `spokenText` emits immediately.
- Voice stays mocked behind `revealStep(stepId)` (see
  `src/voice/voiceInterface.ts`).
- No `localStorage`; state in memory / backend only.

## Project structure

```
src/
  spec/            VisualSpec type, zod validator, example specs   ← the contract
  render/          WhiteboardRenderer (router) + track renderers
    tracks/        FunctionPlot (Track 1), FreeformScene (Track 2), EquationFallback
    hooks/         useDrawSequence (reveal orchestration)
    mathfn.ts      safe single-variable function evaluator
  mascot/          Trudy SVG rig (Phase 4 build-out)
  voice/           voice module interface + mock timer driver
  ui/              TutorShell test harness (person-left / whiteboard-right)
server/            LLM / Merge / RAG stubs (Phase 2/3)
scripts/           testSpec.ts — headless contract self-test
```
