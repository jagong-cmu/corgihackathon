/**
 * RAG store — in-memory corpus with caching.
 *
 * ingestDocument: extract -> chunk -> embed -> store. Extraction + embeddings
 * are CACHED by content hash so the same file is only processed once, never
 * per query (brief requirement). Retrieval is cosine top-k over stored chunks.
 *
 * The store is in-memory (fine for a hackathon / single node). The brief's
 * chroma / pgvector is a drop-in swap: replace `chunks` + `retrieve()` with a
 * vector-DB client; ingest/chunk/embed above stay identical.
 */
import { createHash } from "node:crypto";
import { embedder, embeddingsProvider, cosine } from "./embeddings";
import { extractText, type ExtractKind } from "./extract";
import { chunkText } from "./chunk";

export interface StoredChunk {
  id: string;
  fileId: string;
  fileName: string;
  index: number;
  text: string;
  embedding: number[];
}

export interface Material {
  fileId: string;
  fileName: string;
  mimeType?: string;
  kind: ExtractKind;
  chunks: number;
  chars: number;
}

export interface RetrievedChunk {
  text: string;
  fileName: string;
  fileId: string;
  index: number;
  score: number;
}

interface CacheEntry {
  text: string;
  kind: ExtractKind;
  chunkTexts: string[];
  embeddings: number[][];
}

const chunks: StoredChunk[] = [];
const materials: Material[] = [];
const cache = new Map<string, CacheEntry>();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

export interface IngestInput {
  fileName: string;
  mimeType?: string;
  bytes: Uint8Array;
}

/** Ingest one document. Idempotent by content hash. */
export async function ingestDocument(input: IngestInput): Promise<Material> {
  const hash = sha256(input.bytes);
  const fileId = hash.slice(0, 12);

  // Already ingested this exact file → return existing material.
  const existing = materials.find((m) => m.fileId === fileId);
  if (existing) return existing;

  let entry = cache.get(hash);
  if (!entry) {
    const { text, kind } = await extractText(input.bytes, input.fileName, input.mimeType);
    const chunkTexts = chunkText(text);
    const embeddings = chunkTexts.length ? await embedder.embed(chunkTexts) : [];
    entry = { text, kind, chunkTexts, embeddings };
    cache.set(hash, entry);
  }

  entry.chunkTexts.forEach((text, index) => {
    chunks.push({
      id: `${fileId}:${index}`,
      fileId,
      fileName: input.fileName,
      index,
      text,
      embedding: entry!.embeddings[index],
    });
  });

  const material: Material = {
    fileId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    kind: entry.kind,
    chunks: entry.chunkTexts.length,
    chars: entry.text.length,
  };
  materials.push(material);
  return material;
}

/** Cosine top-k retrieval for a query. */
export async function retrieve(query: string, k = 4): Promise<RetrievedChunk[]> {
  if (chunks.length === 0 || !query.trim()) return [];
  const [qvec] = await embedder.embed([query]);
  const scored = chunks.map((c) => ({
    text: c.text,
    fileName: c.fileName,
    fileId: c.fileId,
    index: c.index,
    score: cosine(qvec, c.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function listMaterials(): Material[] {
  return materials;
}

export function corpusSize(): number {
  return chunks.length;
}

export function provider(): string {
  return embeddingsProvider();
}

export function reset(): void {
  chunks.length = 0;
  materials.length = 0;
  cache.clear();
}
