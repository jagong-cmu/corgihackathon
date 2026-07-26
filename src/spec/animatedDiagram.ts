/**
 * ============================================================================
 *  animated_diagram — a labeled, MOVING illustration primitive.
 * ============================================================================
 *
 * A companion to the other VisualSpec primitives (see visualSpec.ts). Where
 * `freeform_scene` stars a mascot + captions, `animated_diagram` draws a small
 * scene of simple glyphs — balls, boxes, arrows, lines, labels, dots — in a
 * flat [width, height] space (y grows DOWNWARD, like SVG). Elements can EASE
 * from `at` to `moveTo` as their reveal step progresses, so a diagram can show
 * motion (a ball accelerating, water rising, a curve shifting).
 *
 * This is the right primitive for concept / physics / process explanations
 * that benefit from a labeled, animated illustration rather than a mascot with
 * text: Newton's laws, the water cycle, supply & demand, a pulley, etc.
 *
 * The renderer consumes `content` below; the shared zod schema
 * (`animatedDiagramContentSchema`) validates it before rendering, mirroring the
 * per-primitive schemas in validate.ts.
 */

import { z } from "zod";
import { SPEC_VERSION } from "./visualSpec";
import type { VisualSpec } from "./visualSpec";

/** Marker ink for a diagram element. */
export type DiagramColor = "blue" | "berry" | "sage" | "amber" | "ink";

/**
 * One glyph in the scene. `id` MUST equal the id of its drawSequence step so
 * the renderer can reveal it in order.
 *
 * Coordinates live in the diagram's `viewBox` space; y grows DOWNWARD.
 * Geometry fields are kind-specific:
 *   - ball / box / dot : `at` is the center.
 *   - label            : `at` is the text anchor.
 *   - arrow / line     : `from` -> `to`.
 * Any element with `at` may also set `moveTo`: it eases from `at` to `moveTo`
 * as its reveal step plays, producing motion.
 */
export interface DiagramElement {
  id: string; // MUST equal its drawSequence step id
  kind: "ball" | "box" | "arrow" | "line" | "label" | "dot";
  at?: [number, number]; // center for ball/box/dot; anchor for label; y is DOWN
  from?: [number, number]; // arrow/line start
  to?: [number, number]; // arrow/line end
  r?: number;
  w?: number;
  h?: number;
  text?: string;
  color?: DiagramColor;
  moveTo?: [number, number]; // element eases from `at` -> `moveTo` as its step progresses
}

export interface AnimatedDiagramContent {
  viewBox?: [number, number]; // default [100,60]
  elements: DiagramElement[];
  caption?: string;
}

/* ---- Per-primitive content schema (same style as validate.ts) ---- */

const point2 = z.tuple([z.number(), z.number()]);

const diagramColor = z.enum(["blue", "berry", "sage", "amber", "ink"]);

const diagramElementSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["ball", "box", "arrow", "line", "label", "dot"]),
  at: point2.optional(),
  from: point2.optional(),
  to: point2.optional(),
  r: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  text: z.string().optional(),
  color: diagramColor.optional(),
  moveTo: point2.optional(),
});

export const animatedDiagramContentSchema = z.object({
  viewBox: point2.optional(),
  elements: z.array(diagramElementSchema).min(1),
  caption: z.string().optional(),
});

/* ----------------------------------------------------------------------------
 * Example specs. `primitive: "animated_diagram"` is added to the Primitive
 * union by the integrator; these are typed `as VisualSpec` so the file stays
 * self-consistent until that literal lands.
 * ------------------------------------------------------------------------- */

/**
 * Newton's 2nd law (F = m·a) as a basketball being pushed. The force arrow
 * appears, the ball accelerates rightward, the acceleration arrow appears, the
 * mass label appears, then the equation.
 */
export const animatedDiagramNewtonExample: VisualSpec = {
  specVersion: SPEC_VERSION,
  track: "freeform",
  primitive: "animated_diagram",
  content: {
    viewBox: [100, 60],
    elements: [
      {
        id: "force-arrow",
        kind: "arrow",
        from: [6, 38],
        to: [15, 38],
        text: "F",
        color: "berry",
      },
      {
        id: "ball",
        kind: "ball",
        at: [22, 38],
        r: 7,
        moveTo: [72, 38],
        color: "amber",
      },
      {
        id: "accel-arrow",
        kind: "arrow",
        from: [80, 38],
        to: [94, 38],
        text: "a",
        color: "blue",
      },
      {
        id: "mass-label",
        kind: "label",
        at: [22, 52],
        text: "m",
        color: "ink",
      },
      {
        id: "equation",
        kind: "label",
        at: [50, 10],
        text: "F = m · a",
        color: "ink",
      },
    ],
    caption: "Force on a mass produces acceleration: F = m · a.",
  } satisfies AnimatedDiagramContent,
  drawSequence: [
    { id: "force-arrow", element: "force-arrow", durationMs: 600 },
    { id: "ball", element: "ball", durationMs: 1100 },
    { id: "accel-arrow", element: "accel-arrow", durationMs: 600 },
    { id: "mass-label", element: "mass-label", durationMs: 500 },
    { id: "equation", element: "equation", durationMs: 700 },
  ],
  syncCues: [
    { stepId: "force-arrow", atMs: 0 },
    { stepId: "ball", atMs: 700 },
    { stepId: "accel-arrow", atMs: 2000 },
    { stepId: "mass-label", atMs: 2800 },
    { stepId: "equation", atMs: 3600 },
  ],
} as VisualSpec;

/**
 * Supply & demand: two crossing lines meeting at an equilibrium dot. The demand
 * line falls, the supply line rises, the crossing point is marked, and both are
 * labeled.
 */
export const animatedDiagramExample2: VisualSpec = {
  specVersion: SPEC_VERSION,
  track: "freeform",
  primitive: "animated_diagram",
  content: {
    viewBox: [100, 60],
    elements: [
      {
        id: "demand-line",
        kind: "line",
        from: [12, 8],
        to: [88, 50],
        color: "berry",
      },
      {
        id: "supply-line",
        kind: "line",
        from: [12, 50],
        to: [88, 8],
        color: "blue",
      },
      {
        id: "equilibrium",
        kind: "dot",
        at: [50, 29],
        r: 2.5,
        color: "sage",
      },
      {
        id: "demand-label",
        kind: "label",
        at: [86, 54],
        text: "Demand",
        color: "berry",
      },
      {
        id: "supply-label",
        kind: "label",
        at: [86, 6],
        text: "Supply",
        color: "blue",
      },
      {
        id: "price-label",
        kind: "label",
        at: [50, 24],
        text: "Equilibrium price",
        color: "ink",
      },
    ],
    caption: "Where supply meets demand sets the market price.",
  } satisfies AnimatedDiagramContent,
  drawSequence: [
    { id: "demand-line", element: "demand-line", durationMs: 900 },
    { id: "supply-line", element: "supply-line", durationMs: 900 },
    { id: "equilibrium", element: "equilibrium", durationMs: 500 },
    { id: "demand-label", element: "demand-label", durationMs: 600 },
    { id: "supply-label", element: "supply-label", durationMs: 600 },
    { id: "price-label", element: "price-label", durationMs: 700 },
  ],
  syncCues: [
    { stepId: "demand-line", atMs: 0 },
    { stepId: "supply-line", atMs: 1000 },
    { stepId: "equilibrium", atMs: 2100 },
    { stepId: "demand-label", atMs: 2800 },
    { stepId: "supply-label", atMs: 3500 },
    { stepId: "price-label", atMs: 4200 },
  ],
} as VisualSpec;

/* ----------------------------------------------------------------------------
 * Authoring block for the LLM (same bullet style as server/prompt.ts).
 * ------------------------------------------------------------------------- */

export const ANIMATED_DIAGRAM_PROMPT: string = `- A concept, physics, or process explanation that benefits from a labeled, MOVING illustration rather than a mascot + text (e.g. "explain Newton's second law", "show supply and demand", "how does the water cycle work", "explain a pulley"):
    track "freeform", primitive "animated_diagram".
    content: {
      "viewBox"?: [width, height] (default [100, 60]; y grows DOWNWARD like SVG),
      "elements": [ { "id": string, "kind": "ball"|"box"|"arrow"|"line"|"label"|"dot", "at"?: [x,y] (center for ball/box/dot, anchor for label), "from"?: [x,y], "to"?: [x,y] (arrow/line endpoints), "r"?: number, "w"?: number, "h"?: number, "text"?: string, "color"?: "blue"|"berry"|"sage"|"amber"|"ink", "moveTo"?: [x,y] } ],
      "caption"?: string
    }
    Setting "moveTo" makes an element EASE from "at" to "moveTo" as its reveal step plays — use it to show motion (a ball accelerating, water rising).
    Keep the scene to ~4-7 elements laid out in the [100,60] (y-down) space so it stays legible.
    drawSequence lists one step per element in reveal order; each step's "element" MUST equal that element's "id" (and the step "id" matches too).
    Example content: {"viewBox":[100,60],"elements":[{"id":"force","kind":"arrow","from":[6,38],"to":[15,38],"text":"F","color":"berry"},{"id":"ball","kind":"ball","at":[22,38],"r":7,"moveTo":[72,38],"color":"amber"},{"id":"eq","kind":"label","at":[50,10],"text":"F = m · a","color":"ink"}]}`;
