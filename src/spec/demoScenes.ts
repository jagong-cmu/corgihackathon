/**
 * Demo scenes — hand-authored, deterministic answers for the two questions in
 * our live demo, so each ALWAYS produces a clean spoken answer plus a ~10s
 * animated diagram, whether or not the live AI is connected.
 *
 * Used by BOTH turn paths so the result is identical either way:
 *   - server/turn.ts checks this BEFORE calling the LLM (connected demo).
 *   - src/mock.ts checks this in the offline fallback (static GitHub build).
 *
 * "What is Corgi?"                 -> the platform hub (insurance, marketing,
 *                                     partners, analytics) building over ~10s.
 * "What is a risk retention group?"-> member businesses pooling to insure each
 *                                     other, forming a shared coverage pool.
 */
import type { VisualSpec } from "./visualSpec";

export interface DemoTurn {
  spokenText: string;
  visualSpec: VisualSpec;
}

/* -------------------------------------------------------------- What is Corgi */

const corgiScene: VisualSpec = {
  specVersion: 1,
  track: "freeform",
  primitive: "animated_diagram",
  content: {
    viewBox: [100, 60],
    elements: [
      { id: "title", kind: "label", at: [50, 9], text: "Corgi", size: 9, color: "ink" },
      { id: "ins-i", kind: "icon", at: [16, 26], text: "📄", size: 12 },
      { id: "ins-l", kind: "label", at: [16, 37], text: "Insurance", size: 4.6, color: "blue" },
      { id: "mkt-i", kind: "icon", at: [39, 26], text: "☕", size: 12 },
      { id: "mkt-l", kind: "label", at: [39, 37], text: "Marketing", size: 4.6, color: "berry" },
      { id: "par-i", kind: "icon", at: [62, 26], text: "🤝", size: 12 },
      { id: "par-l", kind: "label", at: [62, 37], text: "Partners", size: 4.6, color: "sage" },
      { id: "ana-i", kind: "icon", at: [85, 26], text: "📊", size: 12 },
      { id: "ana-l", kind: "label", at: [85, 37], text: "Analytics", size: 4.6, color: "amber" },
    ],
    caption: "Corgi brings insurance, marketing, partners, and analytics into one place.",
  },
  drawSequence: [
    { id: "title", element: "title", durationMs: 900 },
    { id: "ins-i", element: "ins-i", durationMs: 1400 },
    { id: "ins-l", element: "ins-l", durationMs: 900 },
    { id: "mkt-i", element: "mkt-i", durationMs: 1400 },
    { id: "mkt-l", element: "mkt-l", durationMs: 900 },
    { id: "par-i", element: "par-i", durationMs: 1400 },
    { id: "par-l", element: "par-l", durationMs: 900 },
    { id: "ana-i", element: "ana-i", durationMs: 1400 },
    { id: "ana-l", element: "ana-l", durationMs: 1400 },
  ],
  syncCues: [
    { stepId: "title", atMs: 0 },
    { stepId: "ins-i", atMs: 1100 },
    { stepId: "ins-l", atMs: 2000 },
    { stepId: "mkt-i", atMs: 3200 },
    { stepId: "mkt-l", atMs: 4100 },
    { stepId: "par-i", atMs: 5300 },
    { stepId: "par-l", atMs: 6200 },
    { stepId: "ana-i", atMs: 7600 },
    { stepId: "ana-l", atMs: 8600 },
  ],
};

const CORGI_SPOKEN =
  "Corgi brings everything an insurance business needs into one place — policies and coverage, marketing, partner connections, and analytics — so instead of juggling separate tools, it all lives together.";

/* -------------------------------------------------- What is a risk retention group */

const rrgScene: VisualSpec = {
  specVersion: 1,
  track: "freeform",
  primitive: "animated_diagram",
  content: {
    viewBox: [100, 60],
    elements: [
      { id: "title", kind: "label", at: [50, 8], text: "Risk Retention Group", size: 7, color: "ink" },
      { id: "biz1", kind: "icon", at: [14, 30], text: "🏢", size: 11, moveTo: [32, 33] },
      { id: "biz2", kind: "icon", at: [50, 13], text: "🏬", size: 11, moveTo: [50, 19] },
      { id: "biz3", kind: "icon", at: [86, 30], text: "🏭", size: 11, moveTo: [68, 33] },
      { id: "pool", kind: "icon", at: [50, 34], text: "🛡️", size: 18 },
      { id: "money", kind: "icon", at: [50, 46], text: "💰", size: 11 },
    ],
    caption: "Members pool their premiums to insure each other's liability.",
  },
  drawSequence: [
    { id: "title", element: "title", durationMs: 900 },
    { id: "biz1", element: "biz1", durationMs: 1500 },
    { id: "biz2", element: "biz2", durationMs: 1500 },
    { id: "biz3", element: "biz3", durationMs: 1500 },
    { id: "pool", element: "pool", durationMs: 1600 },
    { id: "money", element: "money", durationMs: 1500 },
  ],
  syncCues: [
    { stepId: "title", atMs: 0 },
    { stepId: "biz1", atMs: 1300 },
    { stepId: "biz2", atMs: 2900 },
    { stepId: "biz3", atMs: 4500 },
    { stepId: "pool", atMs: 6100 },
    { stepId: "money", atMs: 8500 },
  ],
};

const RRG_SPOKEN =
  "A risk retention group is an insurance company owned by its members — businesses in the same industry that band together. Instead of buying coverage from an outside insurer, they pool their premiums and share each other's liability risk.";

/* ------------------------------------------------------------------- matcher */

/**
 * If the question is one of our demo questions, return the hand-authored turn;
 * otherwise null (the caller falls back to the LLM or the keyword mock).
 */
export function matchDemoTurn(userQuery: string): DemoTurn | null {
  const q = userQuery.toLowerCase();
  if (/\bcorgi\b/.test(q)) return { spokenText: CORGI_SPOKEN, visualSpec: corgiScene };
  if (/risk[-\s]?retention\s+group|\brrg\b/.test(q))
    return { spokenText: RRG_SPOKEN, visualSpec: rrgScene };
  return null;
}
