/**
 * Client-side fallback turn. Used when there is no backend reachable (e.g. the
 * static GitHub Pages build has no /api/turn server). Keyword-routed and
 * deterministic — mirrors server/llm.ts's mock so the render pipeline still
 * demonstrates all tracks (including animated diagrams) without a live LLM.
 */
import type { TurnResponse } from "./api";
import type { VisualSpec } from "./spec/visualSpec";
import { vectorDiagramExample, numberLineExample, pythagoreanExample } from "./spec/examples";
import {
  animatedDiagramNewtonExample,
  animatedDiagramExample2,
} from "./spec/animatedDiagram";
import { matchDemoTurn } from "./spec/demoScenes";

const OFFLINE = "(Offline demo — this static build has no live AI; ask on the connected version for any topic.)";

export function clientMockTurn(userQuery: string): TurnResponse {
  // Demo questions ("what is Corgi", "risk retention group") get the exact same
  // hand-authored scene the connected backend serves. See spec/demoScenes.ts.
  const demo = matchDemoTurn(userQuery);
  if (demo) return { ...demo, llm: false };

  const q = userQuery.toLowerCase();
  const wantsPlot =
    /\b(graph|plot|function|derivative|tangent|parabola|curve|x\^?2|sin|cos)\b/.test(q);
  const wantsVector = /\b(vector|vectors|resultant|magnitude|displacement)\b/.test(q);
  const wantsNumberLine =
    /(number line|interval|inequality|less than|greater than|\bbetween\b|\[\s*-?\d)/.test(q);
  const wantsPhysics =
    /\b(newton|force|acceleration|accelerat\w*|gravity|momentum|motion|inertia|velocity|kinetic|friction|physics|energy)\b/.test(
      q
    );
  const wantsEcon = /\b(supply|demand|equilibrium|market price|economic|economics)\b/.test(q);
  const wantsGeometry =
    /(pythagor\w*|hypotenuse|right triangle|right-angle triangle|a\^?2\s*\+\s*b\^?2)/.test(q);

  if (wantsGeometry) {
    return {
      spokenText: `The Pythagorean theorem: in a right triangle, the square on the longest side — the hypotenuse — has the same area as the two squares on the other sides added together. So a² + b² = c². ${OFFLINE}`,
      visualSpec: pythagoreanExample,
      llm: false,
    };
  }

  if (wantsVector) {
    return {
      spokenText: `Here are two vectors, tip to tail — then I add them to get the resultant. ${OFFLINE}`,
      visualSpec: vectorDiagramExample,
      llm: false,
    };
  }

  if (wantsNumberLine) {
    return {
      spokenText: `On the number line: everything greater than negative one and up to three — open at −1, closed at 3. ${OFFLINE}`,
      visualSpec: numberLineExample,
      llm: false,
    };
  }

  if (wantsPhysics) {
    return {
      spokenText: `Newton's second law: force equals mass times acceleration — the harder you push, the more it speeds up. Here it is as a basketball being pushed toward the hoop. ${OFFLINE}`,
      visualSpec: animatedDiagramNewtonExample,
      llm: false,
    };
  }

  if (wantsEcon) {
    return {
      spokenText: `Supply and demand meet at the equilibrium price — watch the two lines cross. ${OFFLINE}`,
      visualSpec: animatedDiagramExample2,
      llm: false,
    };
  }

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
      spokenText: `Here's the graph of x squared, with the tangent at x equals one. ${OFFLINE}`,
      visualSpec: spec,
      llm: false,
    };
  }

  // Abstract / analogy questions with no natural diagram: a short freeform scene.
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
    spokenText: `Let me walk you through it step by step. ${OFFLINE}`,
    visualSpec: spec,
    llm: false,
  };
}
