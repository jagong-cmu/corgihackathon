import { z } from "zod/v4";

/**
 * Bumped on every schema change. Paired with an ADR in docs/adr/ per §13.
 * The client refuses action streams from a worker on a different major.
 */
export const PROTOCOL_VERSION = "0.1.0";

/**
 * A tldraw shape id. Two kinds flow through the protocol:
 *   - `shape:` ids assigned by tldraw for shapes the student created
 *   - ids the model assigns when it creates a shape (see ActionId)
 * Both are accepted anywhere a shape is referenced.
 */
export const ShapeId = z
  .string()
  .min(1)
  .max(64)
  .describe("Id of a shape on the board, either tldraw-assigned (shape:abc) or one you assigned earlier.");

/**
 * A stable id the model assigns when it creates a shape, so it can refer back
 * to that shape in later turns. §5.2: "every created shape gets a stable id".
 */
export const ActionId = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,47}$/,
    "lowercase letters, digits and underscores; must start with a letter",
  )
  .describe(
    "Stable id you assign to this shape so you can reference it in later actions, e.g. 'eq_quadratic' or 'sim_collision'.",
  );

/**
 * Placement is ALWAYS relative to the current section's origin, never absolute
 * across the whole board (§5.2). A section is ~800x600 logical units.
 */
export const SECTION_WIDTH = 800;
export const SECTION_HEIGHT = 600;

export const Point = z
  .strictObject({
    x: z.number().describe("Horizontal offset from the current section's left edge, 0-800."),
    y: z.number().describe("Vertical offset from the current section's top edge, 0-600."),
  })
  .describe("A point relative to the current section's origin.");

export const Bounds = z
  .strictObject({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  })
  .describe("A rectangle relative to the current section's origin.");

/**
 * Closed palette rather than free hex. Keeps the model on-theme and lets the
 * client map to the active tldraw theme (including dark mode) rather than
 * burning in a literal color.
 */
export const Color = z
  .enum(["yellow", "green", "blue", "red", "violet", "orange", "grey"])
  .describe("Semantic highlight color; the client maps it to the active board theme.");

export type ShapeId = z.infer<typeof ShapeId>;
export type ActionId = z.infer<typeof ActionId>;
export type Point = z.infer<typeof Point>;
export type Bounds = z.infer<typeof Bounds>;
export type Color = z.infer<typeof Color>;
