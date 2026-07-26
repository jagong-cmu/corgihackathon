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
  kind: "icon" | "ball" | "box" | "arrow" | "line" | "label" | "dot";
  at?: [number, number]; // center for ball/box/dot; anchor for label; y is DOWN
  from?: [number, number]; // arrow/line start
  to?: [number, number]; // arrow/line end
  r?: number;
  w?: number;
  h?: number;
  size?: number; // font size for an `icon` emoji (~10-16) or a `label` (~5-8)
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
  kind: z.enum(["icon", "ball", "box", "arrow", "line", "label", "dot"]),
  at: point2.optional(),
  from: point2.optional(),
  to: point2.optional(),
  r: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  size: z.number().positive().optional(),
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
        id: "equation",
        kind: "label",
        at: [50, 9],
        text: "F = m · a",
        size: 7,
        color: "ink",
      },
      {
        id: "player",
        kind: "icon",
        at: [12, 41],
        text: "🧑",
        size: 15,
      },
      {
        id: "push",
        kind: "arrow",
        from: [20, 41],
        to: [32, 41],
        text: "your push (F)",
        color: "berry",
      },
      {
        id: "ball",
        kind: "icon",
        at: [38, 41],
        text: "🏀",
        size: 13,
        moveTo: [82, 41],
      },
      {
        id: "accel",
        kind: "arrow",
        from: [86, 41],
        to: [96, 41],
        text: "a",
        color: "blue",
      },
    ],
    caption: "A harder push (F) gives the basketball more acceleration (a).",
  } satisfies AnimatedDiagramContent,
  drawSequence: [
    { id: "equation", element: "equation", durationMs: 600 },
    { id: "player", element: "player", durationMs: 500 },
    { id: "push", element: "push", durationMs: 600 },
    { id: "ball", element: "ball", durationMs: 1500 },
    { id: "accel", element: "accel", durationMs: 600 },
  ],
  syncCues: [
    { stepId: "equation", atMs: 0 },
    { stepId: "player", atMs: 600 },
    { stepId: "push", atMs: 1200 },
    { stepId: "ball", atMs: 2000 },
    { stepId: "accel", atMs: 3500 },
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

export const ANIMATED_DIAGRAM_PROMPT: string = `- A concept, physics, or process that is best TAUGHT with a labeled, MOVING illustration (e.g. "explain Newton's second law", "explain acceleration in basketball terms", "how does a lever work", "show supply and demand", "the water cycle"):
    track "freeform", primitive "animated_diagram".
    content: {
      "viewBox"?: [width, height] (default [100, 60]; drawing area is x: 0..width, y: 0..height, y grows DOWNWARD),
      "elements": [ { "id": string, "kind": "icon"|"ball"|"box"|"arrow"|"line"|"label"|"dot", "at"?: [x,y], "from"?: [x,y], "to"?: [x,y], "text"?: string, "size"?: number, "r"?: number, "w"?: number, "h"?: number, "color"?: "blue"|"berry"|"sage"|"amber"|"ink", "moveTo"?: [x,y] } ],
      "caption"?: string
    }
  ELEMENT KINDS:
    - "icon" — ONE emoji drawn at "at" (set "size" ~10-16). THIS is how you make the scene look like the topic. Use a real-object emoji: 🏀 basketball, ⚽ ball, 🏀🧑 player, 🚗 car, 🚀 rocket, 🪝/⚙️ machine, 💧 water, ☀️ sun, ☁️ cloud, 🦲 magnet, 💡 idea, 📈 graph, 🎯 target. Give an icon a "moveTo" to make it travel/accelerate.
    - "label" — short text at "at" ("size" ~5-8, default 5.5). "arrow"/"line" — from→to, grows on; put a short "text" on it to name the force/flow. "ball" — plain filled circle (only when a generic dot is truly best). "box" — outlined rectangle ("w","h"). "dot" — small marker ("r").
  MOTION: any element with "at" may add "moveTo" — it EASES from "at" to "moveTo" as its step plays. This is the whole point: use it to SHOW the idea happening (the ball accelerates across, the price slides to where the lines cross, water rises).
  MATCH THE STUDENT'S FRAMING — non-negotiable: if they ask for it "in basketball terms", the scene MUST be basketball — a 🏀 a 🧑 pushes/shoots, labels in that language ("your push", "the shot", "the hoop"). NEVER answer a themed request with a generic gray ball. Pick icons and words from the exact context they gave.
  LAYOUT (this is why past scenes looked bad — follow it):
    - 4-7 elements, spread out; never place two things on the same spot or let labels overlap shapes.
    - Show the formula/key relation ONCE, as a "label" near the top center (around [width/2, 9]).
    - The "caption" auto-renders as one line along the BOTTOM: write ONE short plain-language caption, keep the bottom ~10 units clear of your own elements, and do NOT repeat the formula in it.
    - Keep every coordinate a few units inside the viewBox.
  drawSequence: one step per element, ordered so the scene builds like a story (set the stage → apply the cause → show the motion/result). Each step's "id" and "element" equal the element's "id".
  Example (Newton "in basketball terms"): {"viewBox":[100,60],"elements":[{"id":"eq","kind":"label","at":[50,9],"text":"F = m · a","size":7,"color":"ink"},{"id":"player","kind":"icon","at":[12,41],"text":"🧑","size":15},{"id":"push","kind":"arrow","from":[20,41],"to":[32,41],"text":"your push (F)","color":"berry"},{"id":"ball","kind":"icon","at":[38,41],"text":"🏀","size":13,"moveTo":[82,41]},{"id":"accel","kind":"arrow","from":[86,41],"to":[96,41],"text":"a","color":"blue"}],"caption":"A harder push (F) gives the basketball more acceleration (a)."}`;
