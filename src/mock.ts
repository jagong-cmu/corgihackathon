/**
 * Client-side fallback turn. Used when there is no backend reachable (e.g. the
 * static GitHub Pages build has no /api/turn server). Keyword-routed and
 * deterministic — mirrors server/llm.ts's mock so the render pipeline still
 * demonstrates all tracks without a live LLM.
 */
import type { TurnResponse } from "./api";
import type { VisualSpec } from "./spec/visualSpec";

export function clientMockTurn(userQuery: string): TurnResponse {
  const q = userQuery.toLowerCase();
  const wantsPlot =
    /\b(graph|plot|function|derivative|tangent|parabola|curve|x\^?2|sin|cos)\b/.test(q);

  if (wantsPlot) {
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
        "Here's the graph of x squared, with the tangent at x equals one. (Offline demo — this static build has no live LLM backend.)",
      visualSpec: spec,
      llm: false,
    };
  }

  const spec: VisualSpec = {
    specVersion: 1,
    track: "freeform",
    primitive: "freeform_scene",
    content: {
      mascot: "guide",
      beats: [
        { id: "b1", caption: "Let's break this down", pose: "wave", expression: "happy" },
        { id: "b2", caption: "One idea at a time", pose: "point", expression: "think" },
        { id: "b3", caption: "Until it clicks", pose: "cheer", expression: "happy" },
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
      "Let me walk you through it step by step. (Offline demo — this static build has no live LLM backend.)",
    visualSpec: spec,
    llm: false,
  };
}
