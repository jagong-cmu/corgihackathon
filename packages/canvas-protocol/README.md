# @tutor/canvas-protocol

The single source of truth for every message and spec that crosses between the
agent worker and a canvas client (§12 of the root README). Nothing in here
renders anything or calls anything — it is schemas, types, and the tool
definitions derived from them.

**Both tracks depend on this package, so changes need sign-off from both
owners.** Bump `PROTOCOL_VERSION` and add a note in `docs/adr/` for anything
that isn't purely additive (§13).

## What's in it

| Module | Contents |
|---|---|
| `common.ts` | `PROTOCOL_VERSION`, `ShapeId`, `ActionId`, `Point`, `Bounds`, `Color`, section dimensions |
| `actions.ts` | The 12 teaching actions from §5.2 — per-action param schemas, the `ACTION_REGISTRY`, and the `CanvasAction` union |
| `messages.ts` | Data-channel envelopes from §4 — `canvas_action`, `cancel_turn`, `student_event`, `client_hello` |
| `sim.ts` | `SimSpec` from §6.2 and the template registry ids from §6.3 |
| `graph.ts` | `GraphSpec` for the Mafs/function-plot wrapper |
| `tools.ts` | Claude tool definitions generated from the registry |

## Who uses what

**Agent worker (`/apps/agent`)** — calls `canvasToolDefinitions()` to build the
tool list, then emits `CanvasActionMessage`s down the data channel. Validates
against the JSON Schema bundle rather than importing TypeScript:

```bash
npm run export-schemas -w @tutor/canvas-protocol
# -> packages/canvas-protocol/schemas/canvas-protocol.json  (committed)
```

**Canvas client (repo root, `src/`)** — calls `safeParseAgentMessage()` on every
inbound frame and applies only what validates. It returns `null` rather than
throwing, because a dropped action is invisible and a thrown exception ends the
lesson (§13). The single validation boundary is `src/live/frames.ts`; nothing
else in the client parses a frame.

## Adding an action

One place: add an entry to `ACTION_REGISTRY` in `actions.ts` (params schema +
description) and a member to `CanvasActionUnion`. Tool definitions, JSON Schema
export, and the registry test pick it up automatically.

Descriptions become the model's tool descriptions verbatim, so write them
prescriptively — say *when* to call the action, not just what it does.

## Fixtures

`test/fixtures/*.json` are shared golden action streams. They are the
integration contract between the two tracks:

- The **agent** side asserts its emitter produces schema-valid streams.
- The **canvas** side replays these exact files into the editor and asserts
  they render.

Both sides test against the same artifacts before either has seen the other's
code. Add a fixture whenever you add an action or hit an integration bug.

```bash
npm test -w @tutor/canvas-protocol
```

Current fixtures:

- `worked-quadratic` — section, equation, stepped solution, sub-term highlight, graph
- `collision-newton-third` — the README's demo, including a student slider
  change, a barge-in cancel, and the follow-up turn

## Settled since both sides were built

- **`strict: true` is off by default, and that is the right answer.** Tested
  against the live API: 11 strict tools fail with "the compiled grammar is too
  large". Optional properties turned out to be fine — that was the original
  hypothesis and it was wrong. The long note in
  `apps/agent/src/tutor_agent/core/protocol.py` records what actually breaks
  (numeric constraints, tuple `prefixItems`, objects that cannot be closed).
- **`GraphSpec` survived contact with Mafs.** `src/board/shapes/GraphShape.tsx`
  implements functions, points, tangents, shaded regions, and draggable
  parameters against it unchanged. Tangents are computed by central difference
  rather than symbolically, so the slope drawn always matches the curve drawn.
- **Section-relative coordinates are advisory here and load-bearing in the
  client.** Still not range-checked — a slightly out-of-bounds shape should
  render rather than be dropped — but the client lays out a true 800x600
  logical page and scales it as one unit, so `x: 420` really does mean "the
  right half". A shape's width is bounded by the next shape placed to its right,
  which is how "steps on the left, graph on the right" is honoured without
  widths ever crossing the wire.

## Known unknowns

- **Sub-target syntax is convention, not schema.** `term:3` and `line:2` are
  described in prose on `HighlightParams.target.sub` and parsed by the client.
  Nothing validates that the shape being highlighted actually has a term 3, and
  an out-of-range index silently highlights nothing.
