/**
 * RAG pipeline (STUB — built in Phase 3).
 *
 * Pipeline: extract (pdf-parse / mammoth) -> chunk -> embed -> store (chroma or
 * pgvector). CACHE extracted text + embeddings so files are pulled ONCE, not
 * per query. At query time, retrieve top-k chunks to ground the LLM.
 */

export interface Chunk {
  id: string;
  fileId: string;
  text: string;
  embedding?: number[];
}

// TODO(Phase 3): pdf-parse for pdf, mammoth for docx, a pptx extractor for pptx.
export async function extractText(_bytes: Uint8Array, _mime: string): Promise<string> {
  throw new Error("STUB: extraction not implemented (Phase 3).");
}

// TODO(Phase 3): sentence/paragraph-aware chunking with overlap.
export function chunk(_text: string): Chunk[] {
  return [];
}

// TODO(Phase 3): call an embeddings API; cache by content hash.
export async function embed(_chunks: Chunk[]): Promise<Chunk[]> {
  return [];
}

// TODO(Phase 3): cosine top-k over the vector store.
export async function retrieve(_query: string, _k = 5): Promise<Chunk[]> {
  return [];
}
