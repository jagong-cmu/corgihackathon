/**
 * Backend entry (STUB — activated in Phase 2/3).
 *
 * Endpoints (planned):
 *   POST /api/turn    -> { spokenText, visualSpec }  (LLM; Phase 2)
 *   POST /api/ingest  -> kicks off Merge extract/chunk/embed/store (Phase 3)
 *   GET  /api/health  -> Merge content-body check result (Phase 3)
 *
 * Not started by the Vite dev server yet — the frontend runs on hardcoded
 * examples through Phase 1. Phase 2 wires the frontend to POST /api/turn.
 */
import { runTurn } from "./llm";
import { checkContentBodyAvailable } from "./merge";

// TODO(Phase 2): stand up Express (or Vite API routes); mount the handlers below.
export async function handleTurn(userQuery: string, retrievedContext?: string[]) {
  return runTurn({ userQuery, retrievedContext });
}

export async function handleHealth() {
  const merge = await checkContentBodyAvailable();
  return { ok: true, merge };
}
