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
2. **Freeform** (authored mascot SVG rig + `animejs`) — analogy/mascot
   explanations. Home of the hero demo.

## Run it

```bash
npm install
npm run dev        # Vite dev server + /api backend on one origin
npm run test:spec  # validate the spec contract + math evaluator (no browser)
```

Set `ANTHROPIC_API_KEY` for live LLM answers; without it the Ask bar uses an
offline mock. Each test scene is directly linkable: `/?demo=fn`, `/?demo=freeform`, `/?demo=broken`.

## Build order / phase status

- **Phase 0 — Scaffold + spec contract** ✅ `VisualSpec` type, zod validator, KaTeX fallback.
- **Phase 1 — Test UI + Track 1 slice** ✅ Tutor shell (person-left / whiteboard-right); hardcoded `function_plot` draws on + animated tangent; mocked reveal cues + `revealStep`.
- **Phase 2 — Live LLM output** ✅ `POST /api/turn` (Anthropic SDK, model `claude-opus-4-8`) returns `{ spokenText, visualSpec }`; validated server-side with the shared zod schema, retry-once, then `equation` fallback. Ask bar in the UI drives the whiteboard live. Offline mock when `ANTHROPIC_API_KEY` is unset.
- **Phase 3 — Merge / RAG** ⬜ content-body check first, then extract→chunk→embed→store + top-k retrieval.
- **Phase 4 — Mascot rig + freeform renderer** ⬜ component-based SVG rig, animejs pose/expression states (character TBD — pending product decision).
- **Phase 5 — Hero demo** ⬜ Merge-grounded, synced via mocked cues.
- **Phase 6 — Polish + `vector_diagram` + `number_line`** ⬜.

## Guardrails

- The spec is validated (zod) before every render; invalid/unknown → KaTeX
  fallback, **never a white screen**. The server validates too before returning.
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
  mascot/          mascot SVG rig (Phase 4 build-out)
  voice/           voice module interface + mock timer driver
  ui/              TutorShell test harness (person-left / whiteboard-right)
  api.ts           frontend client for POST /api/turn
server/            LLM turn (prompt/llm/turn), Merge/RAG stubs, Vite API plugin
scripts/           testSpec.ts — headless contract self-test
```
