/**
 * Hardcoded example specs. In Phase 1 the renderer is driven by these; in
 * Phase 2 they are replaced by live LLM output of the same shape.
 */
import type { VisualSpec } from "./visualSpec";

/**
 * Track 1 demo: "graph x^2 and show the tangent at x=1".
 * The curve draws on first, then the tangent line slides in.
 */
export const functionPlotExample: VisualSpec = {
  specVersion: 1,
  track: "deterministic",
  primitive: "function_plot",
  content: {
    fn: "x^2",
    domain: [-3, 3],
    range: [-1, 9],
  },
  annotations: [{ type: "tangent", at: 1, label: "tangent at x=1" }],
  drawSequence: [
    { id: "axes", element: "coordinate-plane", durationMs: 400 },
    { id: "curve", element: "function-curve", durationMs: 1400 },
    { id: "tangent", element: "tangent-line", durationMs: 900 },
    { id: "point", element: "tangent-point", durationMs: 300 },
  ],
  syncCues: [
    { stepId: "axes", atMs: 0 },
    { stepId: "curve", onPhrase: "graph of x squared", atMs: 500 },
    { stepId: "tangent", onPhrase: "the tangent at x equals one", atMs: 2100 },
    { stepId: "point", atMs: 3100 },
  ],
};

/**
 * Track 1 demo: vector addition. Two vectors drawn tip-to-tail, then the
 * resultant (origin → sum) snaps in — the classic "a + b" picture.
 */
export const vectorDiagramExample: VisualSpec = {
  specVersion: 1,
  track: "deterministic",
  primitive: "vector_diagram",
  content: {
    vectors: [
      { id: "a", tail: [0, 0], tip: [3, 1], label: "a", color: "blue" },
      { id: "b", tail: [3, 1], tip: [4, 4], label: "b", color: "berry" },
    ],
    showResultant: true,
  },
  drawSequence: [
    { id: "axes", element: "coordinate-plane", durationMs: 300 },
    { id: "va", element: "vector-a", durationMs: 900 },
    { id: "vb", element: "vector-b", durationMs: 900 },
    { id: "vr", element: "resultant", durationMs: 800 },
  ],
  syncCues: [
    { stepId: "axes", atMs: 0 },
    { stepId: "va", onPhrase: "first vector", atMs: 400 },
    { stepId: "vb", onPhrase: "second vector", atMs: 1500 },
    { stepId: "vr", onPhrase: "add them", atMs: 2700 },
  ],
};

/**
 * Track 1 demo: a number line with a highlighted interval and open/closed
 * endpoints — e.g. "x is greater than −1 and at most 3", i.e. (−1, 3].
 */
export const numberLineExample: VisualSpec = {
  specVersion: 1,
  track: "deterministic",
  primitive: "number_line",
  content: {
    min: -5,
    max: 5,
    step: 1,
    interval: { from: -1, to: 3, label: "-1 < x ≤ 3", color: "amber" },
    points: [
      { x: -1, label: "-1", color: "berry", open: true },
      { x: 3, label: "3", color: "sage", open: false },
    ],
  },
  drawSequence: [
    { id: "line", element: "line", durationMs: 1100 },
    { id: "interval", element: "interval", durationMs: 900 },
    { id: "points", element: "points", durationMs: 400 },
  ],
  syncCues: [
    { stepId: "line", atMs: 0 },
    { stepId: "interval", onPhrase: "between", atMs: 1300 },
    { stepId: "points", onPhrase: "endpoints", atMs: 2400 },
  ],
};

/** An intentionally broken spec, used to prove the KaTeX fallback fires. */
export const brokenExample = {
  specVersion: 1,
  track: "deterministic",
  primitive: "function_plot",
  content: { fn: "x^2" }, // missing required `domain`
  drawSequence: [],
} as unknown as VisualSpec;

/**
 * Track 2 test scene (freeform). Generic, subject-agnostic content used only to
 * exercise the freeform renderer + reveal mechanic. The mascot rig is a
 * placeholder pending a product decision on the character (see Trudy.tsx).
 */
export const freeformExample: VisualSpec = {
  specVersion: 1,
  track: "freeform",
  primitive: "freeform_scene",
  content: {
    mascot: "placeholder",
    beats: [
      { id: "b1", caption: "Meet your guide for this lesson", pose: "wave", expression: "happy" },
      { id: "b2", caption: "We'll take one idea at a time", pose: "point", expression: "think" },
      { id: "b3", caption: "Revealed in sync with the narration", pose: "cheer", expression: "happy" },
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
