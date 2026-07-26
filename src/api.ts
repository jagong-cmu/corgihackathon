/**
 * Frontend API client. Talks to the backend mounted on the same origin
 * (see server/vitePlugin.ts).
 */
import type { VisualSpec } from "./spec/visualSpec";

export interface TurnResponse {
  spokenText: string;
  visualSpec: VisualSpec;
  /** Whether the server used a live LLM (vs the offline mock). */
  llm: boolean;
}

/** Ask the tutor a question; returns spoken text + a validated visual spec. */
export async function askTutor(
  userQuery: string,
  retrievedContext?: string[]
): Promise<TurnResponse> {
  const res = await fetch("/api/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userQuery, retrievedContext }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `request failed (${res.status})`);
  }
  return res.json();
}
