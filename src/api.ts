/**
 * Frontend API client. Talks to the backend mounted on the same origin
 * (see server/vitePlugin.ts). On a static host with no backend (e.g. GitHub
 * Pages), /api/turn is absent — we fall back to a client-side mock so the
 * render pipeline still works.
 */
import type { VisualSpec } from "./spec/visualSpec";

export interface TurnResponse {
  spokenText: string;
  visualSpec: VisualSpec;
  /** Whether the server used a live LLM (vs a mock / offline build). */
  llm: boolean;
}

/** Ask the tutor a question; returns spoken text + a validated visual spec. */
export async function askTutor(
  userQuery: string,
  retrievedContext?: string[]
): Promise<TurnResponse> {
  const { clientMockTurn } = await import("./mock");
  let res: Response;
  try {
    res = await fetch("/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userQuery, retrievedContext }),
    });
  } catch {
    // No backend reachable (offline / static host) — use the client mock.
    return clientMockTurn(userQuery);
  }

  if (res.status === 404) {
    // Endpoint absent (static hosting) — client mock.
    return clientMockTurn(userQuery);
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `request failed (${res.status})`);
  }
  // Guard against a static host returning index.html for an unknown route.
  try {
    return (await res.json()) as TurnResponse;
  } catch {
    return clientMockTurn(userQuery);
  }
}
