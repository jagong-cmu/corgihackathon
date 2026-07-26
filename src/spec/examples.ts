/**
 * Hardcoded example specs. In Phase 1 the renderer is driven by these; in
 * Phase 2 they are replaced by live LLM output of the same shape.
 */
import type { VisualSpec } from "./visualSpec";
import type { AnimatedDiagramContent } from "./animatedDiagram";

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

/**
 * The Pythagorean theorem, as the classic "squares on all three sides" proof.
 * A right triangle (legs a, b; hypotenuse c) is drawn, then a square is built on
 * each side — the two leg-squares as axis-aligned boxes, the tilted hypotenuse
 * square from three growing lines (its 4th side IS the hypotenuse). The payoff
 * equation a² + b² = c² lands last. Geometry is a 24-18-30 right triangle.
 */
export const pythagoreanExample: VisualSpec = {
  specVersion: 1,
  track: "freeform",
  primitive: "animated_diagram",
  content: {
    viewBox: [128, 116],
    elements: [
      // the right triangle: horizontal leg a, vertical leg b, hypotenuse c
      { id: "leg-a", kind: "line", from: [50, 64], to: [74, 64], color: "ink" },
      { id: "leg-b", kind: "line", from: [50, 64], to: [50, 46], color: "ink" },
      { id: "hyp", kind: "line", from: [50, 46], to: [74, 64], color: "ink" },
      // little square = the right angle at the corner
      { id: "right-angle", kind: "box", at: [52, 62], w: 4, h: 4, color: "ink" },
      // square on leg b (to the left) and leg a (below)
      { id: "square-b", kind: "box", at: [41, 55], w: 18, h: 18, text: "b²", color: "blue" },
      { id: "square-a", kind: "box", at: [62, 76], w: 24, h: 24, text: "a²", color: "berry" },
      // square on the hypotenuse c — three growing lines close it off
      { id: "sqc-1", kind: "line", from: [74, 64], to: [92, 40], color: "sage" },
      { id: "sqc-2", kind: "line", from: [92, 40], to: [68, 22], color: "sage" },
      { id: "sqc-3", kind: "line", from: [68, 22], to: [50, 46], color: "sage" },
      { id: "square-c-label", kind: "label", at: [71, 43], text: "c²", size: 6, color: "sage" },
      // the payoff, up top
      { id: "equation", kind: "label", at: [64, 12], text: "a² + b² = c²", size: 7, color: "ink" },
    ],
    caption: "The two smaller squares (a² + b²) together equal the big one (c²).",
  } satisfies AnimatedDiagramContent,
  drawSequence: [
    { id: "leg-a", element: "leg-a", durationMs: 500 },
    { id: "leg-b", element: "leg-b", durationMs: 500 },
    { id: "hyp", element: "hyp", durationMs: 700 },
    { id: "right-angle", element: "right-angle", durationMs: 300 },
    { id: "square-b", element: "square-b", durationMs: 700 },
    { id: "square-a", element: "square-a", durationMs: 700 },
    { id: "sqc-1", element: "sqc-1", durationMs: 500 },
    { id: "sqc-2", element: "sqc-2", durationMs: 500 },
    { id: "sqc-3", element: "sqc-3", durationMs: 500 },
    { id: "square-c-label", element: "square-c-label", durationMs: 500 },
    { id: "equation", element: "equation", durationMs: 700 },
  ],
  syncCues: [
    { stepId: "leg-a", atMs: 0 },
    { stepId: "leg-b", atMs: 500 },
    { stepId: "hyp", onPhrase: "hypotenuse", atMs: 1000 },
    { stepId: "right-angle", atMs: 1700 },
    { stepId: "square-b", atMs: 2100 },
    { stepId: "square-a", atMs: 2900 },
    { stepId: "sqc-1", onPhrase: "square on the", atMs: 3700 },
    { stepId: "sqc-2", atMs: 4200 },
    { stepId: "sqc-3", atMs: 4700 },
    { stepId: "square-c-label", atMs: 5200 },
    { stepId: "equation", onPhrase: "equals", atMs: 5800 },
  ],
};
