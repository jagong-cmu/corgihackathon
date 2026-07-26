/**
 * Merge File Storage integration (STUB — built in Phase 3).
 *
 * CRITICAL FIRST CHECK (do this before building anything on Merge):
 *   Confirm `download_file_content` returns actual file BODIES (not just
 *   metadata) for pdf/docx/pptx. If it does NOT, log loudly and fall back to a
 *   local file-upload path. `checkContentBodyAvailable()` is where that probe
 *   lives.
 */

export interface MergeFileRef {
  id: string;
  name: string;
  mimeType: string;
}

export interface ContentBodyCheckResult {
  ok: boolean;
  detail: string;
  sampleBytes?: number;
}

// TODO(Phase 3): call Merge `download_file_content` for a known small file and
// assert we get a non-empty binary body for pdf/docx/pptx. Return ok=false with
// a loud log if only metadata comes back.
export async function checkContentBodyAvailable(): Promise<ContentBodyCheckResult> {
  return {
    ok: false,
    detail:
      "STUB: Merge not connected yet. Phase 3 must verify download_file_content returns real file bodies before building on it; otherwise use the local-upload fallback.",
  };
}

// TODO(Phase 3): list files from connected Merge account (Drive/Dropbox).
export async function listFiles(): Promise<MergeFileRef[]> {
  return [];
}

// TODO(Phase 3): download + return raw bytes for extraction (pdf-parse/mammoth).
export async function downloadFileContent(_fileId: string): Promise<Uint8Array> {
  throw new Error("STUB: Merge download not implemented (Phase 3).");
}
