import { z } from "zod/v4";

/**
 * GraphShape spec (§5.1) — a Mafs / function-plot wrapper.
 * Functions are expression strings evaluated by the client, never eval'd raw;
 * the renderer parses them with a math expression parser.
 */

export const GraphFunction = z.strictObject({
  expr: z
    .string()
    .describe("Function of x in plain math syntax, e.g. 'x^2 - 4*x + 3' or 'sin(x)/x'."),
  label: z.string().optional(),
  color: z.string().optional(),
  domain: z.tuple([z.number(), z.number()]).optional(),
});

export const GraphPoint = z.strictObject({
  x: z.number(),
  y: z.number(),
  label: z.string().optional(),
});

export const GraphTangent = z.strictObject({
  /** Index into the spec's `functions` array. */
  fnIndex: z.number().int().nonnegative(),
  at: z.number().describe("x value at which to draw the tangent line."),
  label: z.string().optional(),
});

export const GraphShadedRegion = z.strictObject({
  fnIndex: z.number().int().nonnegative(),
  from: z.number(),
  to: z.number(),
  label: z.string().optional().describe("e.g. 'area = 4.5'"),
});

/** A parameter the student can drag, which re-renders the graph live. */
export const GraphParameter = z.strictObject({
  name: z.string().describe("Symbol usable inside function expressions, e.g. 'a'."),
  value: z.number(),
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional(),
});

export const GraphSpec = z.strictObject({
  xRange: z.tuple([z.number(), z.number()]).default([-10, 10]),
  yRange: z.tuple([z.number(), z.number()]).default([-10, 10]),
  functions: z.array(GraphFunction).max(6).optional(),
  points: z.array(GraphPoint).max(24).optional(),
  tangents: z.array(GraphTangent).max(6).optional(),
  shaded: z.array(GraphShadedRegion).max(6).optional(),
  parameters: z.array(GraphParameter).max(4).optional(),
  showGrid: z.boolean().optional(),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
});

export type GraphSpec = z.infer<typeof GraphSpec>;
