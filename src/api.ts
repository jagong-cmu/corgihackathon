/**
 * Client for the tutor API (`apps/api`).
 *
 * Everything HTTP the browser does goes through here. In development Vite
 * proxies `/api` to the FastAPI process, so this is same-origin and there is no
 * CORS configuration anywhere in the stack.
 *
 * There is no LLM call in this file and there should never be one again. The
 * tutor's turns happen over the LiveKit room, driven by the agent worker; this
 * is session setup and the learner's materials.
 */

const API = "/api";

export interface RetrievalStatus {
  available: boolean;
  embeddings?: string;
  detail?: string;
}

export interface SessionInfo {
  userId: string;
  persisted: boolean;
  room: string;
  identity: string;
  url: string;
  token: string;
  persona: string;
  retrieval: RetrievalStatus;
}

export interface Material {
  uploadId: string;
  filename: string;
  kind: string;
  chunks: number;
  byteSize: number;
  createdAt?: string;
}

export interface SourceChunk {
  chunkId: string;
  text: string;
  uri: string | null;
  title: string | null;
}

/**
 * FastAPI puts a string in `detail` for a plain error and an object for a
 * structured one. Flatten both into something a person can read — the raw shape
 * rendered into a status line is `[object Object]`.
 */
async function failure(response: Response): Promise<Error> {
  let detail: unknown;
  try {
    detail = (await response.json())?.detail;
  } catch {
    detail = null;
  }
  if (typeof detail === "string") return new Error(detail);
  if (detail && typeof detail === "object" && "detail" in detail) {
    return new Error(String((detail as { detail: unknown }).detail));
  }
  return new Error(detail ? JSON.stringify(detail) : `${response.status} ${response.statusText}`);
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

export async function startSession(
  options: { persona?: string; userId?: string } = {},
): Promise<SessionInfo> {
  const response = await fetch(`${API}/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.userId ? { "x-user-id": options.userId } : {}),
    },
    body: JSON.stringify({ persona: options.persona ?? null }),
  });
  const body = await json<{
    user_id: string;
    persisted: boolean;
    room: string;
    identity: string;
    url: string;
    token: string;
    persona: string;
    retrieval: RetrievalStatus;
  }>(response);

  return {
    userId: body.user_id,
    persisted: body.persisted,
    room: body.room,
    identity: body.identity,
    url: body.url,
    token: body.token,
    persona: body.persona,
    retrieval: body.retrieval,
  };
}

interface MaterialWire {
  upload_id: string;
  filename: string;
  kind: string;
  chunks: number;
  byte_size: number;
  created_at?: string;
}

const toMaterial = (m: MaterialWire): Material => ({
  uploadId: m.upload_id,
  filename: m.filename,
  kind: m.kind,
  chunks: m.chunks,
  byteSize: m.byte_size,
  createdAt: m.created_at,
});

export async function listMaterials(
  userId: string,
): Promise<{ materials: Material[]; retrieval: RetrievalStatus }> {
  const response = await fetch(`${API}/materials`, { headers: { "x-user-id": userId } });
  const body = await json<{ materials: MaterialWire[]; retrieval: RetrievalStatus }>(response);
  return { materials: body.materials.map(toMaterial), retrieval: body.retrieval };
}

export async function uploadMaterial(userId: string, file: File): Promise<Material> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API}/materials`, {
    method: "POST",
    headers: { "x-user-id": userId },
    body: form,
  });
  return toMaterial(await json<MaterialWire>(response));
}

export async function deleteMaterial(userId: string, uploadId: string): Promise<void> {
  const response = await fetch(`${API}/materials/${uploadId}`, {
    method: "DELETE",
    headers: { "x-user-id": userId },
  });
  if (!response.ok) throw await failure(response);
}

/** Backs `show_source`: the board asks for the excerpt the tutor is teaching from. */
export async function fetchChunk(userId: string, chunkId: string): Promise<SourceChunk> {
  const response = await fetch(`${API}/materials/chunks/${encodeURIComponent(chunkId)}`, {
    headers: { "x-user-id": userId },
  });
  const body = await json<{
    chunk_id: string;
    text: string;
    uri: string | null;
    title: string | null;
  }>(response);
  return { chunkId: body.chunk_id, text: body.text, uri: body.uri, title: body.title };
}

export interface Health {
  status: string;
  database: string;
  livekit: string;
  retrieval: RetrievalStatus;
}

export async function getHealth(): Promise<Health> {
  return json<Health>(await fetch(`${API}/health`));
}
