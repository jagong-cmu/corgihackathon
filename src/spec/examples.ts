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
