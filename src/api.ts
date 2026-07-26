/**
 * Frontend API client. Talks to the backend mounted on the same origin
 * (see server/vitePlugin.ts). On a static host with no backend (e.g. GitHub
 * Pages), /api/turn is absent — we fall back to a client-side mock so the
 * render pipeline still works.
 */
import type { VisualSpec } from "./spec/visualSpec";

export interface Grounding {
  /** Whether retrieved material was passed to the LLM this turn. */
  used: boolean;
  /** File names the grounding chunks came from. */
  sources: string[];
  /** Number of chunks used. */
  k: number;
}

export interface TurnResponse {
  spokenText: string;
  visualSpec: VisualSpec;
  /** Whether the server used a live LLM (vs a mock / offline build). */
  llm: boolean;
  /** Present when the backend grounded the answer in ingested materials. */
  grounding?: Grounding;
}

export interface Material {
  fileId: string;
  fileName: string;
  mimeType?: string;
  kind: string;
  chunks: number;
  chars: number;
}

export interface MaterialsResponse {
  materials: Material[];
  corpusSize: number;
  provider: string;
  merge: { ok: boolean; detail: string };
}

/**
 * No backend on this host (static hosting like GitHub Pages). If the user has
 * supplied an Anthropic key (see llmClient.ts) we ask Claude DIRECTLY from the
 * browser so any question still gets a real answer + visual; otherwise we fall
 * back to the keyword mock.
 */
async function offlineTurn(userQuery: string): Promise<TurnResponse> {
  try {
    const { hasAiKey, clientAiTurn } = await import("./llmClient");
    if (hasAiKey()) return await clientAiTurn(userQuery);
  } catch {
    /* AI unavailable/failed — fall through to the deterministic mock */
  }
  const { clientMockTurn } = await import("./mock");
  return clientMockTurn(userQuery);
}

/** Ask the tutor a question; returns spoken text + a validated visual spec. */
export async function askTutor(
  userQuery: string,
  retrievedContext?: string[]
): Promise<TurnResponse> {
  let res: Response;
  try {
    res = await fetch("/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userQuery, retrievedContext }),
    });
  } catch {
    return offlineTurn(userQuery);
  }
  // Any non-OK response means there's no usable backend on this host (static
  // hosting returns 404 / 405 / 501 / 403 depending on the provider) — fall
  // back to the offline turn (browser AI if a key is set, else the mock).
  if (!res.ok) return offlineTurn(userQuery);
  try {
    return (await res.json()) as TurnResponse;
  } catch {
    return offlineTurn(userQuery);
  }
}

/** Read a File as base64 (no data-URL prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Upload files to be ingested (extract → chunk → embed → store). This is the
 * local fallback for Merge; grounded answers use the resulting corpus.
 */
export async function ingestFiles(files: File[]): Promise<MaterialsResponse> {
  const payload = {
    files: await Promise.all(
      files.map(async (f) => ({
        name: f.name,
        mimeType: f.type,
        dataBase64: await fileToBase64(f),
      }))
    ),
  };
  const res = await fetch("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `ingest failed (${res.status})`);
  }
  return res.json();
}

/** List ingested materials + corpus/provider/merge status. */
export async function getMaterials(): Promise<MaterialsResponse> {
  const res = await fetch("/api/materials");
  if (!res.ok) throw new Error(`materials failed (${res.status})`);
  return res.json();
}

/** Trigger a Merge sync (live only; no-op when Merge isn't configured). */
export async function syncMerge(): Promise<{ configured: boolean; ingested: number }> {
  const res = await fetch("/api/merge/sync", { method: "POST" });
  if (!res.ok) throw new Error(`merge sync failed (${res.status})`);
  return res.json();
}
