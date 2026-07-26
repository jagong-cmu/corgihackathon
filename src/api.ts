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
    return clientMockTurn(userQuery);
  }
  // No backend on this host (static hosting like GitHub Pages): a POST to a
  // path that only serves static files returns 404 (not found) or 405 (method
  // not allowed). Either way, fall back to the client-side mock.
  if (res.status === 404 || res.status === 405) return clientMockTurn(userQuery);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `request failed (${res.status})`);
  }
  try {
    return (await res.json()) as TurnResponse;
  } catch {
    return clientMockTurn(userQuery);
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
