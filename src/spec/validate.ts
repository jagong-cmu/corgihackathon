/**
 * Zod validation for VisualSpec. GUARDRAIL: every spec is validated before it
 * is rendered. On an invalid/unknown spec the renderer falls back to a plain
 * KaTeX equation — it must NEVER white-screen.
 */
import { z } from "zod";
import { SPEC_VERSION } from "./visualSpec";
import type { VisualSpec } from "./visualSpec";

const annotationSchema = z.object({
  type: z.string(),
  at: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
  label: z.string().optional(),
});

const drawStepSchema = z.object({
  id: z.string().min(1),
  element: z.string().min(1),
  durationMs: z.number().nonnegative(),
});

const syncCueSchema = z.object({
  stepId: z.string().min(1),
  onPhrase: z.string().optional(),
  atMs: z.number().nonnegative().optional(),
});

export const visualSpecSchema = z.object({
  specVersion: z.literal(SPEC_VERSION),
  track: z.enum(["deterministic", "freeform"]),
  primitive: z.enum([
    "function_plot",
    "vector_diagram",
    "geometry",
    "number_line",
    "equation",
    "freeform_scene",
  ]),
  content: z.record(z.unknown()),
  annotations: z.array(annotationSchema).optional(),
  drawSequence: z.array(drawStepSchema),
  syncCues: z.array(syncCueSchema).optional(),
});

/* ---- Per-primitive content schemas (checked after the envelope passes) ---- */

const functionPlotContentSchema = z.object({
  fn: z.string().min(1),
  domain: z.tuple([z.number(), z.number()]),
  range: z.tuple([z.number(), z.number()]).optional(),
});

const freeformSceneContentSchema = z.object({
  mascot: z.string().optional(),
  beats: z
    .array(
      z.object({
        id: z.string().min(1),
        caption: z.string(),
        pose: z.string().optional(),
        expression: z.string().optional(),
        props: z.array(z.string()).optional(),
      })
    )
    .min(1),
});

const equationContentSchema = z.object({
  tex: z.string().min(1),
});

const contentSchemaByPrimitive: Partial<
  Record<VisualSpec["primitive"], z.ZodTypeAny>
> = {
  function_plot: functionPlotContentSchema,
  freeform_scene: freeformSceneContentSchema,
  equation: equationContentSchema,
};

export type ValidationResult =
  | { ok: true; spec: VisualSpec }
  | { ok: false; error: string };

/**
 * Validate an unknown value as a VisualSpec. Returns a discriminated result so
 * callers can render a fallback on `ok: false` instead of throwing.
 */
export function validateVisualSpec(input: unknown): ValidationResult {
  const envelope = visualSpecSchema.safeParse(input);
  if (!envelope.success) {
    return { ok: false, error: `envelope: ${envelope.error.message}` };
  }
  const spec = envelope.data as VisualSpec;

  // Second pass: validate primitive-specific content when we have a schema.
  const contentSchema = contentSchemaByPrimitive[spec.primitive];
  if (contentSchema) {
    const contentResult = contentSchema.safeParse(spec.content);
    if (!contentResult.success) {
      return {
        ok: false,
        error: `content(${spec.primitive}): ${contentResult.error.message}`,
      };
    }
  }
  return { ok: true, spec };
}

/**
 * Best-effort extraction of a TeX string for the KaTeX fallback, so even an
 * otherwise-broken spec can degrade to showing *something* meaningful.
 */
export function fallbackTexFrom(input: unknown): string {
  try {
    const obj = input as { content?: Record<string, unknown> };
    const c = obj?.content ?? {};
    if (typeof c.tex === "string") return c.tex;
    if (typeof c.fn === "string") return `y = ${String(c.fn)}`;
  } catch {
    /* ignore */
  }
  return "\\text{(could not render this visual)}";
}
