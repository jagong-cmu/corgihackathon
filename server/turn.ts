/**
 * runTurn — the validated turn pipeline.
 *
 *   callLLM -> validate (shared zod) -> retry once with the error -> fallback.
 *
 * GUARDRAIL: we return a spec that is GUARANTEED valid against the shared
 * schema. If the model can't produce one in two tries, we synthesize an
 * `equation` fallback so the renderer never receives garbage (and, worst case,
 * the renderer's own zod guard shows the KaTeX fallback).
 */
import type { TurnResult, VisualSpec } from "../src/spec/visualSpec";
import { validateVisualSpec } from "../src/spec/validate";
import { callLLM, mockTurn, type TurnRequest } from "./llm";

function equationFallback(spokenText: string, note: string): TurnResult {
  const visualSpec: VisualSpec = {
    specVersion: 1,
    track: "deterministic",
    primitive: "equation",
    content: { tex: "\\text{(no visual for this one)}" },
    drawSequence: [{ id: "eq", element: "equation", durationMs: 500 }],
    syncCues: [{ stepId: "eq", atMs: 0 }],
  };
  return {
    spokenText: spokenText || "Here's what I can tell you.",
    visualSpec: { ...visualSpec, content: { tex: note } },
  };
}

export async function runTurn(req: TurnRequest): Promise<TurnResult> {
  let lastError = "";
  let spokenText = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: { spokenText: unknown; visualSpec: unknown };
    try {
      raw = await callLLM(req, attempt > 0 ? lastError : undefined);
    } catch (e) {
      lastError = `LLM call failed: ${(e as Error).message}`;
      break;
    }

    spokenText = typeof raw.spokenText === "string" ? raw.spokenText : spokenText;

    const result = validateVisualSpec(raw.visualSpec);
    if (result.ok) {
      return { spokenText: spokenText || "Let's take a look.", visualSpec: result.spec };
    }
    lastError = result.error;
  }

  // Both attempts failed (or the API errored). Degrade gracefully:
  // if there's no key we already returned a valid mock via callLLM; here we
  // only reach the fallback when a live model produced invalid specs twice.
  if (!process.env.ANTHROPIC_API_KEY) {
    const m = mockTurn(req);
    return { spokenText: m.spokenText, visualSpec: m.visualSpec };
  }
  return equationFallback(
    spokenText,
    "\\text{Sorry — I couldn't build a clean visual for that.}"
  );
}
