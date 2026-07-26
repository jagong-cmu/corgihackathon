/**
 * LLM turn service (STUB — wired live in Phase 2).
 *
 * Contract: given (userQuery + retrievedContext), return { spokenText, visualSpec }.
 * The SAME turn produces spoken text (for the voice teammate's TTS) and a
 * compact VisualSpec (for our renderer). The LLM NEVER emits animation code.
 *
 * Phase 2 replaces the mock with a real server-side call (provider TBD by user)
 * that is prompted to output ONLY a VisualSpec matching src/spec/visualSpec.ts,
 * validated with the shared zod schema before returning.
 */
import type { TurnResult, VisualSpec } from "../src/spec/visualSpec";

export interface TurnRequest {
  userQuery: string;
  retrievedContext?: string[];
}

// TODO(Phase 2): call the real LLM; force JSON output; validate with zod;
// retry once on invalid; fall back to an `equation` spec on repeated failure.
export async function runTurn(req: TurnRequest): Promise<TurnResult> {
  const q = req.userQuery.toLowerCase();

  // Naive mock routing so the endpoint is exercisable before the real LLM.
  if (q.includes("corgi")) {
    const spec: VisualSpec = {
      specVersion: 1,
      track: "freeform",
      primitive: "freeform_scene",
      content: {
        mascot: "trudy",
        // TODO(Phase 5): fill beats from `req.retrievedContext` (Merge facts).
        beats: [
          { id: "b1", caption: "Corgi helps insurers move fast", pose: "wave", expression: "happy" },
          { id: "b2", caption: "It connects their data across tools", pose: "point", expression: "think" },
          { id: "b3", caption: "Teams ship in days, not months", pose: "cheer", expression: "happy" },
        ],
      },
      drawSequence: [
        { id: "b1", element: "beat-1", durationMs: 1200 },
        { id: "b2", element: "beat-2", durationMs: 1200 },
        { id: "b3", element: "beat-3", durationMs: 1200 },
      ],
      syncCues: [
        { stepId: "b1", atMs: 0 },
        { stepId: "b2", atMs: 1600 },
        { stepId: "b3", atMs: 3200 },
      ],
    };
    return {
      spokenText:
        "Let me show you what Corgi does. It helps insurers move fast by connecting their data, so teams ship in days, not months.",
      visualSpec: spec,
    };
  }

  // Default: a deterministic function plot.
  const spec: VisualSpec = {
    specVersion: 1,
    track: "deterministic",
    primitive: "function_plot",
    content: { fn: "x^2", domain: [-3, 3], range: [-1, 9] },
    annotations: [{ type: "tangent", at: 1, label: "tangent at x=1" }],
    drawSequence: [
      { id: "axes", element: "coordinate-plane", durationMs: 400 },
      { id: "curve", element: "function-curve", durationMs: 1400 },
      { id: "tangent", element: "tangent-line", durationMs: 900 },
      { id: "point", element: "tangent-point", durationMs: 300 },
    ],
    syncCues: [
      { stepId: "axes", atMs: 0 },
      { stepId: "curve", atMs: 500 },
      { stepId: "tangent", atMs: 2100 },
      { stepId: "point", atMs: 3100 },
    ],
  };
  return {
    spokenText:
      "Here's the graph of x squared. I'll draw the curve, then the tangent at x equals one.",
    visualSpec: spec,
  };
}
