/**
 * Merge File Storage integration.
 *
 * CRITICAL FIRST CHECK (brief): before building anything on Merge, confirm
 * `download_file_content` returns actual file BODIES (not just metadata) for
 * pdf/docx/pptx. `checkContentBodyAvailable()` does exactly that when creds are
 * present; when they're absent it LOGS LOUDLY and reports the local-upload
 * fallback as the active path.
 *
 * Credentials (set both to go live):
 *   MERGE_API_KEY        — your Merge production access key
 *   MERGE_ACCOUNT_TOKEN  — the linked end-user account token (from Merge Link)
 */
import { ingestDocument, type Material } from "./rag";

const BASE = "https://api.merge.dev/api/filestorage/v1";
const API_KEY = process.env.MERGE_API_KEY;
const ACCOUNT_TOKEN = process.env.MERGE_ACCOUNT_TOKEN;

function mergeHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "X-Account-Token": ACCOUNT_TOKEN ?? "",
  };
}

export function mergeConfigured(): boolean {
  return !!API_KEY && !!ACCOUNT_TOKEN;
}

export interface MergeFileRef {
  id: string;
  name: string;
  mimeType: string;
}

export interface ContentBodyCheckResult {
  ok: boolean;
  detail: string;
  sampleBytes?: number;
  fallback: "local-upload";
}

// ---- The critical up-front check ----
export async function checkContentBodyAvailable(): Promise<ContentBodyCheckResult> {
  if (!mergeConfigured()) {
    // LOUD: this is the branch the brief says to handle explicitly.
    console.warn(
      "[merge] NOT CONFIGURED — MERGE_API_KEY / MERGE_ACCOUNT_TOKEN unset. " +
        "download_file_content cannot be verified. FALLING BACK to the local " +
        "file-upload path (POST /api/ingest)."
    );
    return {
      ok: false,
      detail:
        "Merge not configured. Using the local file-upload fallback (POST /api/ingest). " +
        "Set MERGE_API_KEY and MERGE_ACCOUNT_TOKEN to enable Merge ingestion.",
      fallback: "local-upload",
    };
  }

  try {
    const files = await listFiles();
    const target =
      files.find((f) => /\.(pdf|docx|pptx)$/i.test(f.name)) ?? files[0];
    if (!target) {
      return {
        ok: false,
        detail: "Merge connected, but no files found in the linked account.",
        fallback: "local-upload",
      };
    }
    const bytes = await downloadFileContent(target.id);
    // The check: we must get a non-trivial BINARY body, not a JSON metadata blob.
    const looksLikeJson =
      bytes.length > 0 && (bytes[0] === 0x7b || bytes[0] === 0x5b); // { or [
    const ok = bytes.length > 64 && !looksLikeJson;
    if (!ok) {
      console.warn(
        "[merge] download_file_content returned metadata / empty body, not a real file. " +
          "FALLING BACK to local upload."
      );
    }
    return {
      ok,
      detail: ok
        ? `download_file_content OK — got ${bytes.length} bytes for "${target.name}".`
        : "download_file_content did NOT return a real file body — using local upload fallback.",
      sampleBytes: bytes.length,
      fallback: "local-upload",
    };
  } catch (e) {
    console.warn("[merge] content-body check failed:", (e as Error).message);
    return {
      ok: false,
      detail: `Merge check errored: ${(e as Error).message}. Using local upload fallback.`,
      fallback: "local-upload",
    };
  }
}

/** List files in the linked account (live only). */
export async function listFiles(): Promise<MergeFileRef[]> {
  if (!mergeConfigured()) return [];
  const res = await fetch(`${BASE}/files`, { headers: mergeHeaders() });
  if (!res.ok) throw new Error(`Merge /files ${res.status}`);
  const json = (await res.json()) as {
    results: { id: string; name: string; mime_type?: string; file_type?: string }[];
  };
  return json.results.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mime_type ?? f.file_type ?? "",
  }));
}

/** Download raw bytes for a file (live only) — this is `download_file_content`. */
export async function downloadFileContent(fileId: string): Promise<Uint8Array> {
  if (!mergeConfigured()) throw new Error("Merge not configured");
  const res = await fetch(`${BASE}/files/${fileId}/download`, {
    headers: mergeHeaders(),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Merge download ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Pull every pdf/docx/pptx from the linked Merge account and ingest it. Live
 * only; returns [] with a loud log when Merge isn't configured (use local
 * upload instead).
 */
export async function mergeSyncIngest(): Promise<Material[]> {
  if (!mergeConfigured()) {
    console.warn("[merge] sync requested but Merge not configured — no-op. Use POST /api/ingest.");
    return [];
  }
  const files = await listFiles();
  const out: Material[] = [];
  for (const f of files) {
    if (!/\.(pdf|docx|pptx|txt|md)$/i.test(f.name)) continue;
    const bytes = await downloadFileContent(f.id);
    out.push(await ingestDocument({ fileName: f.name, mimeType: f.mimeType, bytes }));
  }
  return out;
}
