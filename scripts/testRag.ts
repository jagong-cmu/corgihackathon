/**
 * Headless RAG self-test: chunk -> embed -> retrieve, plus the embedder's
 * cosine behavior. Run with `npm run test:rag`. No browser, no network
 * (uses the local embedder unless an embeddings key is set).
 */
import { chunkText } from "../server/chunk";
import { embedder, cosine } from "../server/embeddings";
import { ingestDocument, retrieve, corpusSize, reset } from "../server/rag";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) failures++;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// A fictional document with invented facts the base model cannot know.
const DOC = `The Kelvin Protocol — Overview

The Kelvin Protocol is a fictional data-exchange standard invented for this test.
It was ratified in the city of Aldermere and is maintained by the Frost Council.

Core ideas.
The protocol moves records in sealed units called "flakes". Each flake carries
exactly seven fields and is signed with a rotating amber key. Flakes expire after
ninety minutes unless renewed by a warden node.

Why it matters.
Because flakes are small and self-describing, the Kelvin Protocol lets unrelated
systems share records without a central database. The Frost Council reports that
adoption tripled after the amber-key rotation was introduced.`;

async function main() {
  // 1. Chunking produces at least one non-empty chunk.
  const chunks = chunkText(DOC, { maxChars: 300, overlapChars: 60 });
  check("chunkText yields chunks", chunks.length >= 2, `${chunks.length} chunks`);

  // 2. Embedder: identical text ~ 1.0, unrelated text low.
  const [a, b, c] = await embedder.embed([
    "amber key rotation warden node",
    "amber key rotation warden node",
    "graph the derivative of x squared",
  ]);
  check("cosine(identical) ~= 1", cosine(a, b) > 0.98, cosine(a, b).toFixed(3));
  check("cosine(unrelated) is low", cosine(a, c) < 0.2, cosine(a, c).toFixed(3));

  // 3. Ingest + retrieve: on-topic query surfaces the right chunk.
  reset();
  const bytes = new Uint8Array(Buffer.from(DOC, "utf8"));
  const material = await ingestDocument({ fileName: "kelvin.txt", mimeType: "text/plain", bytes });
  check("ingest stored chunks", material.chunks >= 1 && corpusSize() >= 1, `${material.chunks} chunks`);

  const hits = await retrieve("What are flakes in the Kelvin Protocol?", 3);
  check("retrieve returns hits", hits.length > 0);
  check(
    "top hit mentions flakes",
    /flake/i.test(hits[0]?.text ?? ""),
    `score ${hits[0]?.score.toFixed(3)}`
  );

  // 4. Off-topic query scores lower than the on-topic query's top hit.
  const off = await retrieve("graph a parabola and its tangent", 3);
  check(
    "off-topic scores below on-topic",
    (off[0]?.score ?? 0) < (hits[0]?.score ?? 0),
    `off ${off[0]?.score.toFixed(3)} vs on ${hits[0]?.score.toFixed(3)}`
  );

  // 5. Idempotent ingest (same bytes) doesn't double-store.
  const before = corpusSize();
  await ingestDocument({ fileName: "kelvin.txt", mimeType: "text/plain", bytes });
  check("re-ingest is idempotent", corpusSize() === before, `${corpusSize()} chunks`);

  console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} FAILURE(S) ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
