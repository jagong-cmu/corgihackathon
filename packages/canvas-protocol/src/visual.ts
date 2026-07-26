import { z } from "zod";
import { ActionId } from "./common.js";

/**
 * VisualSpec — the whiteboard renderer's contract, as seen by the protocol.
 *
 * The Chalk whiteboard (root `src/`) renders a compact Visual Spec as a
 * draw-on animation: `drawSequence` lists reveal steps, and each step stays
 * hidden until something calls `revealStep(stepId)`. In a live voice session
 * that something is the `reveal_step` action below, which inherits a real
 * TTS-timestamp `cueMs` like every other canvas action — that is the whole
 * voice↔whiteboard sync mechanism.
 *
 * This schema validates the ENVELOPE only. `content` is primitive-specific
 * and deliberately open: the client re-validates the full spec (including
 * per-primitive content) with its own zod validator before rendering, and
 * falls back to KaTeX rather than white-screening (§13). Duplicating the
 * per-primitive shapes here would give us two sources of truth for the same
 * contract, which is how the two halves drifted apart the first time.
 */

/** One reveal step. Mirrors DrawStep in src/spec/visualSpec.ts. */
export const VisualDrawStep = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe("Step id. reveal_step refers to this; for animated_diagram it must equal the element's id."),
  element: z
    .string()
    .min(1)
    .max(64)
    .describe("Renderer element this step reveals. Element names are primitive-specific and prescriptive — see the whiteboard rules in your system prompt."),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .describe("How long the element takes to draw on once revealed, in ms. 400-1200 reads naturally."),
});

/**
 * Sync cues are part of the client's spec type but are IGNORED in live voice
 * sessions — reveal timing comes from `reveal_step` cues, which are anchored
 * to real TTS timestamps instead of guessed offsets. Accepted here so a spec
 * that carries them still validates; the model is prompted to omit them.
 */
export const VisualSyncCue = z.strictObject({
  stepId: z.string().min(1),
  onPhrase: z.string().optional(),
  atMs: z.number().int().min(0).optional(),
});

export const VisualAnnotation = z.strictObject({
  type: z.string().min(1).describe("Annotation kind, e.g. 'tangent'."),
  at: z
    .union([z.number(), z.tuple([z.number(), z.number()])])
    .optional()
    .describe("Primitive-specific anchor: a scalar x-value or an [x, y] point."),
  label: z.string().optional(),
});

/** The primitives the whiteboard client can actually render today. */
export const VisualPrimitive = z.enum([
  "function_plot",
  "vector_diagram",
  "number_line",
  "animated_diagram",
  "equation",
  "freeform_scene",
]);

export const VisualSpec = z.strictObject({
  specVersion: z.literal(1),
  track: z
    .enum(["deterministic", "freeform"])
    .describe("'deterministic' for real math primitives, 'freeform' for freeform_scene."),
  primitive: VisualPrimitive,
  content: z
    .record(z.string(), z.unknown())
    .describe("Primitive-specific payload — the exact shape per primitive is in your whiteboard rules."),
  annotations: z.array(VisualAnnotation).max(16).optional(),
  drawSequence: z
    .array(VisualDrawStep)
    .min(1)
    .max(24)
    .describe("Every element of the visual, in reveal order. All steps start hidden."),
  syncCues: z
    .array(VisualSyncCue)
    .max(24)
    .optional()
    .describe("Omit. Live sessions time reveals via reveal_step, not authored offsets."),
});

export const PresentVisualParams = z.strictObject({
  id: ActionId,
  spec: VisualSpec,
});

export const RevealStepParams = z.strictObject({
  stepId: z
    .string()
    .min(1)
    .max(64)
    .describe("Id of a drawSequence step in the visual you presented with present_visual this turn."),
});

export type VisualDrawStep = z.infer<typeof VisualDrawStep>;
export type VisualSpec = z.infer<typeof VisualSpec>;
export type PresentVisualParams = z.infer<typeof PresentVisualParams>;
export type RevealStepParams = z.infer<typeof RevealStepParams>;
