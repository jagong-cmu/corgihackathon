/**
 * The board model: what the whiteboard looks like right now.
 *
 * The agent does not send pictures or a scene graph. It sends the 12 teaching
 * actions from §5.2, incrementally, each timed to the words it belongs to. This
 * module is the reduction of that stream into state a renderer can draw.
 *
 * ## The board is sectioned, and placement is section-relative
 *
 * §5.2: "placement is relative to the current section, never absolute". A
 * section is a 800x600 logical page. `new_section` appends a fresh one and moves
 * the cursor to it; everything created afterwards lands there. The board is the
 * learner's reviewable notes, so sections accumulate downward and are never
 * discarded — the model is prompted to prefer `new_section` over erasing, and
 * `clear_region` is the sharp tool it should rarely reach for.
 *
 * ## Shapes are addressed by the id the model assigned
 *
 * Every creating action carries an `id`, and later actions (`highlight`,
 * `point_at`, `sim_control`) reference it. Re-creating an existing id replaces
 * that shape in place rather than stacking a duplicate on top of it — actions
 * are meant to be idempotent (set semantics, not toggle), and a re-sent frame
 * after a reconnect must not double the board.
 *
 * ## Nothing here throws
 *
 * An action referencing a shape that does not exist is ignored. That happens
 * legitimately: barge-in can cancel the turn that would have created it, and a
 * highlight for a shape that never arrived is a no-op, not a crash (§13).
 */

import type {
  Bounds,
  CanvasAction,
  Color,
  GraphSpec,
  Point,
  SimSpec,
} from "@tutor/canvas-protocol";

export const SECTION_WIDTH = 800;
export const SECTION_HEIGHT = 600;

/**
 * How long each line of a `write_steps` shape waits before the next appears.
 *
 * The protocol has no per-line cue — an action gets one `cueMs` — so the reveal
 * has to be paced locally. A second per line is roughly the speed a tutor reads
 * a step aloud, and it self-corrects: a `highlight` on `line:N` snaps the reveal
 * forward to at least that line, so narration that runs ahead of the pacing
 * pulls the board along with it rather than leaving the learner watching a line
 * being discussed that is not yet visible.
 */
export const STEP_REVEAL_MS = 1000;

export interface ShapeBase {
  id: string;
  x: number;
  y: number;
  /** Playback position when this shape landed; drives the entry animation. */
  bornAtMs: number;
}

export interface EquationShape extends ShapeBase {
  kind: "equation";
  latex: string;
}

export interface StepsShape extends ShapeBase {
  kind: "steps";
  lines: string[];
  reveal: "one_by_one" | "all";
  /** How many lines are currently visible. */
  revealed: number;
  /** Playback position the reveal is paced from. */
  revealStartedMs: number;
}

export interface GraphShape extends ShapeBase {
  kind: "graph";
  spec: GraphSpec;
  /** Live values for `spec.parameters`, which the learner can drag. */
  parameters: Record<string, number>;
}

export interface SimShape extends ShapeBase {
  kind: "sim";
  spec: SimSpec;
  playing: boolean;
  speed: number;
  /** `spec.params` with any `sim_update` applied on top. */
  params: Record<string, number | string | boolean>;
}

export interface SourceShape extends ShapeBase {
  kind: "source";
  chunkId: string | null;
  mergeFileRef: { linkedAccountId: string; remoteId: string } | null;
  region: Bounds | null;
}

export type Shape = EquationShape | StepsShape | GraphShape | SimShape | SourceShape;

export interface Section {
  id: string;
  title: string;
  shapes: Shape[];
}

export interface Pointer {
  x: number;
  y: number;
  style: "laser" | "arrow";
  sectionIndex: number;
  /** Playback position at which this pointer disappears. */
  expiresAtMs: number;
}

export interface Highlight {
  color: Color;
  /** e.g. "term:3" or "line:2", or null for the whole shape. */
  sub: string | null;
}

export interface FocusTarget {
  sectionIndex: number;
  shapeId: string | null;
  /** Monotonic, so a repeated focus on the same shape still scrolls. */
  nonce: number;
}

export interface BoardState {
  sections: Section[];
  activeSectionIndex: number;
  /** Keyed by shape id. Set semantics: a second highlight replaces the first. */
  highlights: Record<string, Highlight>;
  pointer: Pointer | null;
  focus: FocusTarget | null;
}

export function emptyBoard(): BoardState {
  return {
    // One section always exists, so the very first `equation` has somewhere to
    // land even if the model never calls new_section.
    sections: [{ id: "section-0", title: "", shapes: [] }],
    activeSectionIndex: 0,
    highlights: {},
    pointer: null,
    focus: null,
  };
}

function activeSection(state: BoardState): Section {
  return state.sections[state.activeSectionIndex];
}

/** Locate a shape anywhere on the board by the id the model gave it. */
export function findShape(
  state: BoardState,
  shapeId: string,
): { shape: Shape; sectionIndex: number } | null {
  for (let i = 0; i < state.sections.length; i += 1) {
    const shape = state.sections[i].shapes.find((s) => s.id === shapeId);
    if (shape) return { shape, sectionIndex: i };
  }
  return null;
}

/** Replace-or-append, so a repeated id never stacks two shapes. */
function place(state: BoardState, shape: Shape): BoardState {
  const sections = state.sections.map((section, index) => {
    if (index !== state.activeSectionIndex) {
      // A shape being recreated in a different section moves; drop the stale one.
      const filtered = section.shapes.filter((s) => s.id !== shape.id);
      return filtered.length === section.shapes.length ? section : { ...section, shapes: filtered };
    }
    const existing = section.shapes.findIndex((s) => s.id === shape.id);
    const shapes =
      existing === -1
        ? [...section.shapes, shape]
        : section.shapes.map((s, i) => (i === existing ? shape : s));
    return { ...section, shapes };
  });
  return { ...state, sections };
}

function resolvePoint(
  state: BoardState,
  target: string | Point,
): { x: number; y: number; sectionIndex: number } | null {
  if (typeof target !== "string") {
    return { x: target.x, y: target.y, sectionIndex: state.activeSectionIndex };
  }
  const found = findShape(state, target);
  if (!found) return null;
  // Point slightly above-left of the shape's origin so the marker sits on the
  // shape rather than covering its first character.
  return { x: found.shape.x, y: found.shape.y, sectionIndex: found.sectionIndex };
}

export interface ApplyContext {
  /** Playback position when the action fired. */
  nowMs: number;
}

/**
 * Apply one canvas action. Pure: returns a new state, or the same object when
 * the action was a no-op (an unknown shape id, a sim control for a graph).
 */
export function applyAction(
  state: BoardState,
  action: CanvasAction,
  { nowMs }: ApplyContext,
): BoardState {
  switch (action.type) {
    case "new_section": {
      const sections = [
        ...state.sections,
        { id: `section-${state.sections.length}`, title: action.title, shapes: [] },
      ];
      const activeSectionIndex = sections.length - 1;
      return {
        ...state,
        sections,
        activeSectionIndex,
        // An arrow left pointing at the previous section would sit on top of
        // the new one at the same coordinates.
        pointer: null,
        focus: { sectionIndex: activeSectionIndex, shapeId: null, nonce: nowMs },
      };
    }

    case "equation":
      return place(state, {
        kind: "equation",
        id: action.id,
        x: action.x,
        y: action.y,
        latex: action.latex,
        bornAtMs: nowMs,
      });

    case "write_steps":
      return place(state, {
        kind: "steps",
        id: action.id,
        x: action.x,
        y: action.y,
        lines: action.lines,
        reveal: action.reveal ?? "one_by_one",
        revealed: (action.reveal ?? "one_by_one") === "all" ? action.lines.length : 1,
        revealStartedMs: nowMs,
        bornAtMs: nowMs,
      });

    case "graph":
      return place(state, {
        kind: "graph",
        id: action.id,
        x: action.x,
        y: action.y,
        spec: action.spec,
        parameters: Object.fromEntries(
          (action.spec.parameters ?? []).map((p) => [p.name, p.value]),
        ),
        bornAtMs: nowMs,
      });

    case "spawn_sim":
      return place(state, {
        kind: "sim",
        id: action.id,
        x: action.x,
        y: action.y,
        spec: action.spec,
        playing: true,
        speed: 1,
        params: { ...(action.spec.params ?? {}) },
        bornAtMs: nowMs,
      });

    case "show_source":
      return place(state, {
        kind: "source",
        id: action.id,
        x: action.x,
        y: action.y,
        chunkId: "chunkId" in action.source ? action.source.chunkId : null,
        mergeFileRef: "mergeFileRef" in action.source ? action.source.mergeFileRef : null,
        region: action.region ?? null,
        bornAtMs: nowMs,
      });

    case "highlight": {
      const shapeId = typeof action.target === "string" ? action.target : action.target.shapeId;
      const sub = typeof action.target === "string" ? null : action.target.sub;
      const found = findShape(state, shapeId);
      if (!found) return state;

      const next: BoardState = {
        ...state,
        highlights: { ...state.highlights, [shapeId]: { color: action.color ?? "yellow", sub } },
      };

      // Narration is ahead of the paced reveal: pull the board forward so the
      // line being discussed is on screen.
      if (found.shape.kind === "steps" && sub?.startsWith("line:")) {
        const line = Number.parseInt(sub.slice("line:".length), 10);
        if (Number.isFinite(line) && line + 1 > found.shape.revealed) {
          return updateShape(next, shapeId, (shape) =>
            shape.kind === "steps"
              ? {
                  ...shape,
                  revealed: Math.min(shape.lines.length, line + 1),
                  // Re-anchor so the next line is a full interval away rather
                  // than appearing immediately after the jump.
                  revealStartedMs: nowMs - (line + 1) * STEP_REVEAL_MS,
                }
              : shape,
          );
        }
      }
      return next;
    }

    case "point_at": {
      const at = resolvePoint(state, action.target as string | Point);
      if (!at) return state;
      return {
        ...state,
        pointer: {
          x: at.x,
          y: at.y,
          style: action.style ?? "laser",
          sectionIndex: at.sectionIndex,
          expiresAtMs: nowMs + (action.holdMs ?? 1500),
        },
      };
    }

    case "camera": {
      if (typeof action.target === "string") {
        const found = findShape(state, action.target);
        if (!found) return state;
        return {
          ...state,
          focus: { sectionIndex: found.sectionIndex, shapeId: action.target, nonce: nowMs },
        };
      }
      return {
        ...state,
        focus: { sectionIndex: state.activeSectionIndex, shapeId: null, nonce: nowMs },
      };
    }

    case "clear_region": {
      const { x, y, w, h } = action.bounds;
      const section = activeSection(state);
      // A shape is cleared when its origin falls inside the rectangle. Shapes
      // have no declared size in the protocol, so origin-containment is the
      // only rule both sides can agree on without inventing dimensions.
      const survivors = section.shapes.filter(
        (shape) => !(shape.x >= x && shape.x <= x + w && shape.y >= y && shape.y <= y + h),
      );
      if (survivors.length === section.shapes.length) return state;

      const cleared = new Set(
        section.shapes.filter((s) => !survivors.includes(s)).map((s) => s.id),
      );
      const highlights = Object.fromEntries(
        Object.entries(state.highlights).filter(([id]) => !cleared.has(id)),
      );
      return {
        ...state,
        highlights,
        sections: state.sections.map((s, i) =>
          i === state.activeSectionIndex ? { ...s, shapes: survivors } : s,
        ),
      };
    }

    case "sim_control":
      return updateShape(state, action.id, (shape) => {
        if (shape.kind !== "sim") return shape;
        switch (action.op) {
          case "play":
            return { ...shape, playing: true };
          case "pause":
            return { ...shape, playing: false };
          case "replay":
            // A replay restarts the animation, which the renderer keys off
            // bornAtMs.
            return { ...shape, playing: true, bornAtMs: nowMs };
          case "speed":
            return { ...shape, speed: action.value ?? shape.speed };
          default:
            return shape;
        }
      });

    case "sim_update":
      return updateShape(state, action.id, (shape) =>
        shape.kind === "sim"
          ? { ...shape, params: { ...shape.params, [action.param]: action.value } }
          : shape,
      );

    default:
      return state;
  }
}

function updateShape(
  state: BoardState,
  shapeId: string,
  update: (shape: Shape) => Shape,
): BoardState {
  let changed = false;
  const sections = state.sections.map((section) => {
    const index = section.shapes.findIndex((s) => s.id === shapeId);
    if (index === -1) return section;
    const next = update(section.shapes[index]);
    if (next === section.shapes[index]) return section;
    changed = true;
    return {
      ...section,
      shapes: section.shapes.map((s, i) => (i === index ? next : s)),
    };
  });
  return changed ? { ...state, sections } : state;
}

/**
 * Advance time-driven state: pointer expiry and the paced step reveal.
 *
 * Driven by playback position rather than wall time, for the same reason cues
 * are: if the audio stalls, a half-revealed derivation should stall with it
 * instead of racing ahead of the narration.
 */
export function tickBoard(state: BoardState, nowMs: number): BoardState {
  let next = state;

  if (next.pointer && nowMs >= next.pointer.expiresAtMs && next.pointer.style === "laser") {
    // Arrows persist until the section changes; laser dots are transient deixis.
    next = { ...next, pointer: null };
  }

  let sectionsChanged = false;
  const sections = next.sections.map((section) => {
    let shapesChanged = false;
    const shapes = section.shapes.map((shape) => {
      if (shape.kind !== "steps" || shape.reveal === "all") return shape;
      if (shape.revealed >= shape.lines.length) return shape;
      const due = Math.floor((nowMs - shape.revealStartedMs) / STEP_REVEAL_MS) + 1;
      const revealed = Math.min(shape.lines.length, Math.max(shape.revealed, due));
      if (revealed === shape.revealed) return shape;
      shapesChanged = true;
      return { ...shape, revealed };
    });
    if (!shapesChanged) return section;
    sectionsChanged = true;
    return { ...section, shapes };
  });

  return sectionsChanged ? { ...next, sections } : next;
}
