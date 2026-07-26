import { z } from "zod/v4";

/**
 * The analogy engine's template registry (§6.3). Adding a template must never
 * require touching the engine core — but it DOES require adding the id here,
 * because the model can only emit templates it knows exist.
 */
export const SimTemplateId = z.enum([
  // physics
  "collision_2body",
  "projectile",
  "inclined_plane",
  "pendulum",
  // math + stats
  "distribution_sampler",
  "function_explorer",
  // subject-agnostic
  "timeline",
  "labeled_diagram",
  "annotated_map",
  "flow_diagram",
  // escape hatch (§6.3) — LLM-authored p5.js in a sandboxed iframe.
  // Every use is logged to event_log; recurring uses get promoted to templates.
  "p5_sketch",
]);

export const SimOverlay = z
  .enum([
    "force_vectors",
    "velocity_vectors",
    "momentum_hud",
    "energy_hud",
    "slowmo_at_impact",
    "trace_path",
    "grid",
  ])
  .describe("Visual overlay computed from the simulation state, not drawn by hand.");

/**
 * An object participating in the simulation. Fields beyond sprite/label are
 * template-specific; the template's own Zod schema validates them on build().
 */
export const SimObject = z.looseObject({
  sprite: z
    .string()
    .describe(
      "Sprite key resolved against the learner's themed asset pack, falling back to a built-in procedural sprite.",
    ),
  label: z.string().optional().describe("Label rendered next to the object, e.g. 'Ball A'."),
  mass: z.number().positive().optional(),
  v: z.number().optional().describe("Initial velocity along the template's primary axis."),
});

/**
 * A narration cue tied to a simulation event. The engine is deterministic
 * (§6.4), so the agent can predict when 'at' fires without executing anything.
 */
export const SimBeat = z.strictObject({
  at: z
    .string()
    .describe("Named engine event to fire on, e.g. 'impact', 'apex', 'rest'. Template-specific."),
  say: z.string().describe("Narration text to speak when this event fires."),
});

/** §6.2. The full spec the model emits for spawn_sim. */
export const SimSpec = z.strictObject({
  template: SimTemplateId,
  theme: z
    .string()
    .describe(
      "Interest-taxonomy key that resolves sprites, e.g. 'basketball'. Must come from the learner's interest profile — never free text.",
    ),
  objects: z.array(SimObject).min(1).max(12),
  params: z
    .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
    .optional()
    .describe("Template-specific parameters, e.g. { restitution: 0.85 }."),
  overlays: z.array(SimOverlay).optional(),
  beats: z.array(SimBeat).optional(),
  seed: z
    .number()
    .int()
    .optional()
    .describe("Seed for any randomness. Required for reproducible replay; the client supplies one if omitted."),
});

export type SimTemplateId = z.infer<typeof SimTemplateId>;
export type SimOverlay = z.infer<typeof SimOverlay>;
export type SimObject = z.infer<typeof SimObject>;
export type SimBeat = z.infer<typeof SimBeat>;
export type SimSpec = z.infer<typeof SimSpec>;
