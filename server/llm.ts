/**
 * LLM turn service — Phase 2 (LIVE).
 *
 * Contract: given (userQuery + retrievedContext), return { spokenText, visualSpec }.
 * The same turn produces spoken text (for the voice teammate's TTS) and a
 * compact VisualSpec (for our renderer). The LLM NEVER emits animation code.
 *
 * Uses the official Anthropic SDK when ANTHROPIC_API_KEY is present; otherwise
 * falls back to a deterministic mock so the pipeline is exercisable offline.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { TurnResult, VisualSpec } from "../src/spec/visualSpec";
import { vectorDiagramExample, numberLineExample } from "../src/spec/examples";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

export interface TurnRequest {
  userQuery: string;
  retrievedContext?: string[];
}

// Default to the latest capable Claude model; override via env if desired.
const MODEL = process.env.WHITEBOARD_LLM_MODEL ?? "claude-opus-4-8";

const hasKey = !!process.env.ANTHROPIC_API_KEY;
const client = hasKey ? new Anthropic() : null;

export function llmAvailable(): boolean {
  return hasKey;
}

/** Strip markdown fences and extract the first JSON object from model text. */
function extractJson(text: string): unknown {
  let t = text.trim();
  // Remove ```json ... ``` fences if present.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Grab from the first { to the last } (models sometimes add a stray word).
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/**
 * Raw LLM call. Returns the parsed { spokenText, visualSpec } WITHOUT
 * validation (the turn handler validates). `repairNote` lets the retry pass
 * feed the previous validation error back to the model.
 */
export async function callLLM(
  req: TurnRequest,
  repairNote?: string
): Promise<{ spokenText: unknown; visualSpec: unknown }> {
  if (!client) return mockTurn(req);

  const userPrompt =
    buildUserPrompt(req.userQuery, req.retrievedContext) +
    (repairNote
      ? `\n\nYour previous attempt was invalid: ${repairNote}\nReturn corrected JSON only.`
      : "");

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const obj = extractJson(text) as { spokenText?: unknown; visualSpec?: unknown };
  return { spokenText: obj?.spokenText, visualSpec: obj?.visualSpec };
}

/* --------------------------------------------------------------------------
 * Offline mock (used when no ANTHROPIC_API_KEY). Keyword-routed, deterministic.
 * ------------------------------------------------------------------------ */
export function mockTurn(req: TurnRequest): { spokenText: string; visualSpec: VisualSpec } {
  const q = req.userQuery.toLowerCase();
  const wantsPlot = /\b(graph|plot|function|derivative|tangent|parabola|curve|x\^?2|sin|cos)\b/.test(q);
  const wantsVector = /\b(vector|vectors|resultant|magnitude|force|displacement)\b/.test(q);
  const wantsNumberLine =
    /(number line|interval|inequality|less than|greater than|\bbetween\b|\[\s*-?\d)/.test(q);

  if (wantsVector) {
    return {
      spokenText:
        "Here are two vectors, tip to tail — then I add them to get the resultant. (offline mock — add an API key for live answers.)",
      visualSpec: vectorDiagramExample,
    };
  }

  if (wantsNumberLine) {
    return {
      spokenText:
        "On the number line, everything greater than negative one and up to three — open at −1, closed at 3. (offline mock — add an API key for live answers.)",
      visualSpec: numberLineExample,
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
      spokenText:
        "Here's the graph of x squared. I'll draw the curve, then the tangent at x equals one. (offline mock — add an API key for live answers.)",
      visualSpec: spec,
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
      "Let me walk you through it step by step. (offline mock — add an API key for live answers.)",
    visualSpec: spec,
  };
}

// Legacy name kept for the server/index.ts stub import.
export async function runTurn(req: TurnRequest): Promise<TurnResult> {
  const { runTurn: run } = await import("./turn");
  return run(req);
}
