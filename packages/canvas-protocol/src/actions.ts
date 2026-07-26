import { z } from "zod";
import { ActionId, Bounds, Color, Point, ShapeId } from "./common.js";
import { GraphSpec } from "./graph.js";
import { SimSpec } from "./sim.js";

/**
 * The teaching action set (§5.2).
 *
 * Each action is defined ONCE as a params schema, then used two ways:
 *   - the agent worker turns params into a Claude tool definition (tools.ts)
 *   - the client validates the tagged union before touching the tldraw editor
 *
 * Conventions the model is prompted with and these validators enforce:
 *   - placement is relative to the current section, never absolute
 *   - prefer new_section over erasing; the board doubles as the student's notes
 *   - every created shape gets a stable `id`
 *   - actions are idempotent where possible (set semantics, not toggle)
 */

// ---------------------------------------------------------------------------
// Pointing and emphasis
// ---------------------------------------------------------------------------

const PointTarget = z
  .union([ShapeId, Point])
  .describe("Either the id of an existing shape, or a raw {x, y} point in the current section.");

export const PointAtParams = z.strictObject({
  target: PointTarget,
  style: z
    .enum(["laser", "arrow"])
    .default("laser")
    .describe("'laser' is a transient dot for deixis; 'arrow' persists until the section changes."),
  holdMs: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(1500)
    .describe("How long the pointer stays visible."),
});

const HighlightTarget = z.union([
  ShapeId,
  z.strictObject({
    shapeId: ShapeId,
    sub: z
      .string()
      .describe(
        "Sub-target inside a composite shape, e.g. 'term:3' for the 4th term of an EquationShape or 'line:2' for a StepsShape line.",
      ),
  }),
]);

export const HighlightParams = z.strictObject({
  target: HighlightTarget,
  color: Color.default("yellow"),
});

// ---------------------------------------------------------------------------
// Creating content
// ---------------------------------------------------------------------------

export const WriteStepsParams = z.strictObject({
  ...Point.shape,
  id: ActionId,
  lines: z
    .array(z.string())
    .min(1)
    .max(12)
    .describe("Worked-problem lines, one per step. Keep each under ~80 characters."),
  reveal: z
    .enum(["one_by_one", "all"])
    .default("one_by_one")
    .describe("'one_by_one' reveals lines as you narrate them; use it for anything you're explaining."),
});

export const EquationParams = z.strictObject({
  ...Point.shape,
  id: ActionId,
  latex: z.string().describe("KaTeX-compatible LaTeX, without surrounding $ delimiters."),
});

export const GraphParams = z.strictObject({
  ...Point.shape,
  id: ActionId,
  spec: GraphSpec,
});

export const SpawnSimParams = z.strictObject({
  ...Point.shape,
  id: ActionId,
  spec: SimSpec,
});

// ---------------------------------------------------------------------------
// Driving a running simulation
// ---------------------------------------------------------------------------

const SimControlShape = z.strictObject({
  id: ShapeId.describe("Id of a simulation you created with spawn_sim."),
  op: z.enum(["play", "pause", "replay", "speed"]),
  value: z
    .number()
    .positive()
    .optional()
    .describe("Playback rate; required when op is 'speed' (1 = realtime, 0.25 = slow motion)."),
});

/**
 * JSON Schema can't express "value is required when op is 'speed'", so strict
 * tool use won't enforce it. The client does, via CanvasAction below.
 */
const speedNeedsValue = (v: { op: string; value?: number }) =>
  v.op !== "speed" || v.value !== undefined;

const SPEED_VALUE_ERROR = "sim_control with op 'speed' requires a value";

export const SimControlParams = SimControlShape.refine(speedNeedsValue, {
  message: SPEED_VALUE_ERROR,
  path: ["value"],
});

export const SimUpdateParams = z.strictObject({
  id: ShapeId,
  param: z.string().describe("Parameter name from the simulation's spec.params."),
  value: z.union([z.number(), z.string(), z.boolean()]),
});

// ---------------------------------------------------------------------------
// Teaching on the learner's own materials (§5.1 SourceShape)
// ---------------------------------------------------------------------------

const SourceRef = z.union([
  z.strictObject({
    chunkId: z.string().describe("Id of a chunk already in the retrieval index."),
  }),
  z.strictObject({
    mergeFileRef: z
      .strictObject({
        linkedAccountId: z.string(),
        remoteId: z.string(),
      })
      .describe("A file the action plane fetched that is not yet indexed."),
  }),
]);

export const ShowSourceParams = z.strictObject({
  ...Point.shape,
  id: ActionId,
  source: SourceRef,
  region: Bounds.optional().describe("Crop within the source document, if only part is relevant."),
});

// ---------------------------------------------------------------------------
// Board management
// ---------------------------------------------------------------------------

export const NewSectionParams = z.strictObject({
  title: z.string().max(80).describe("Heading for the new section, e.g. 'Part 2: the derivative'."),
});

export const ClearRegionParams = z.strictObject({
  bounds: Bounds,
});

export const CameraParams = z.strictObject({
  op: z.literal("focus"),
  target: z.union([ShapeId, Bounds]),
});

// ---------------------------------------------------------------------------
// Registry — the single place an action is declared
// ---------------------------------------------------------------------------

/**
 * Descriptions here become the model's tool descriptions verbatim, so they are
 * prescriptive about WHEN to call, not just what the action does.
 */
export const ACTION_REGISTRY = {
  point_at: {
    params: PointAtParams,
    description:
      "Point at something on the board. Call this whenever you say 'this', 'here', or 'that' about something visible — deictic speech without a pointer is confusing.",
  },
  highlight: {
    params: HighlightParams,
    description:
      "Highlight a shape or a sub-part of one. Call this when you single out a specific term, line, or region while explaining it.",
  },
  write_steps: {
    params: WriteStepsParams,
    description:
      "Write a worked solution as numbered lines revealed one at a time. Call this for any multi-step derivation or procedure — do not narrate steps that aren't on the board.",
  },
  equation: {
    params: EquationParams,
    description:
      "Render a typeset equation. Call this instead of speaking symbols aloud whenever the notation itself matters.",
  },
  graph: {
    params: GraphParams,
    description:
      "Plot functions, points, tangents, or shaded regions. Call this for anything about rates of change, area, intersections, or the shape of a relationship.",
  },
  spawn_sim: {
    params: SpawnSimParams,
    description:
      "Spawn an interactive, physically-correct simulation themed to the learner's interests. Call this for any concept involving motion, force, sampling, or change over time.",
  },
  sim_control: {
    params: SimControlParams,
    description:
      "Play, pause, replay, or change the speed of a running simulation. Use 'speed' with a low value to slow down the moment you're describing.",
  },
  sim_update: {
    params: SimUpdateParams,
    description:
      "Change one parameter of a running simulation so the learner sees the effect. Call this when answering 'what if' questions.",
  },
  show_source: {
    params: ShowSourceParams,
    description:
      "Display an excerpt of the learner's own material (a slide, a page, a wiki block) so you can teach on top of it. Prefer this over paraphrasing when their source uses specific notation or wording.",
  },
  new_section: {
    params: NewSectionParams,
    description:
      "Scroll to fresh board space with a heading. Prefer this over clear_region — the board is the learner's reviewable notes.",
  },
  clear_region: {
    params: ClearRegionParams,
    description:
      "Erase a rectangle of the board. Use sparingly; new_section is almost always the better choice.",
  },
  camera: {
    params: CameraParams,
    description: "Move the camera to focus on a shape or region already on the board.",
  },
} as const satisfies Record<string, { params: z.ZodType; description: string }>;

export type ActionName = keyof typeof ACTION_REGISTRY;

export const ACTION_NAMES = Object.keys(ACTION_REGISTRY) as ActionName[];

/**
 * The tagged union the client validates. `type` is the discriminator and
 * matches the tool name the model called.
 *
 * Kept as a bare discriminated union so it survives z.toJSONSchema() — the
 * cross-field rules live on CanvasAction below, which is what the client uses.
 */
export const CanvasActionUnion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("point_at") }).extend(PointAtParams.shape),
  z.object({ type: z.literal("highlight") }).extend(HighlightParams.shape),
  z.object({ type: z.literal("write_steps") }).extend(WriteStepsParams.shape),
  z.object({ type: z.literal("equation") }).extend(EquationParams.shape),
  z.object({ type: z.literal("graph") }).extend(GraphParams.shape),
  z.object({ type: z.literal("spawn_sim") }).extend(SpawnSimParams.shape),
  z.object({ type: z.literal("sim_control") }).extend(SimControlShape.shape),
  z.object({ type: z.literal("sim_update") }).extend(SimUpdateParams.shape),
  z.object({ type: z.literal("show_source") }).extend(ShowSourceParams.shape),
  z.object({ type: z.literal("new_section") }).extend(NewSectionParams.shape),
  z.object({ type: z.literal("clear_region") }).extend(ClearRegionParams.shape),
  z.object({ type: z.literal("camera") }).extend(CameraParams.shape),
]);

/** The union plus the cross-field rules JSON Schema can't express. */
export const CanvasAction = CanvasActionUnion.refine(
  (a) => a.type !== "sim_control" || speedNeedsValue(a),
  { message: SPEED_VALUE_ERROR, path: ["value"] },
);

export type CanvasAction = z.infer<typeof CanvasActionUnion>;
