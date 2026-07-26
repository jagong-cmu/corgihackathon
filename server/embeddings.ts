/**
 * Pluggable embeddings.
 *
 * - If an embeddings API key is present (OPENAI_API_KEY or EMBEDDINGS_API_KEY),
 *   use a real provider (OpenAI text-embedding-3-small via fetch).
 * - Otherwise fall back to a LOCAL deterministic lexical embedder (feature
 *   hashing / signed bag-of-words over unigrams + bigrams, L2-normalized).
 *   This gives real, working cosine retrieval with zero external dependencies,
 *   so the whole RAG loop is demoable offline. Swap in a real provider by
 *   setting the key — no other code changes.
 */

export interface Embedder {
  name: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

const LOCAL_DIM = 1024;

const STOPWORDS = new Set(
  "the a an and or of to in is are was were be been being it its this that these those for on with as at by from".split(
    " "
  )
);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

/** FNV-1a 32-bit hash → used for feature hashing (index + sign). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Local signed feature-hashing embedder. Deterministic, no network. */
function localEmbed(text: string): number[] {
  const vec = new Float64Array(LOCAL_DIM);
  const toks = tokenize(text);

  // term counts over unigrams + bigrams
  const counts = new Map<string, number>();
  for (let i = 0; i < toks.length; i++) {
    counts.set(toks[i], (counts.get(toks[i]) ?? 0) + 1);
    if (i + 1 < toks.length) {
      const bg = toks[i] + "_" + toks[i + 1];
      counts.set(bg, (counts.get(bg) ?? 0) + 1);
    }
  }

  for (const [term, c] of counts) {
    const h = fnv1a(term);
    const idx = h % LOCAL_DIM;
    const sign = (h & 0x80000000) !== 0 ? -1 : 1;
    const w = 1 + Math.log(c); // sublinear tf
    vec[idx] += sign * w;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < LOCAL_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array<number>(LOCAL_DIM);
  for (let i = 0; i < LOCAL_DIM; i++) out[i] = vec[i] / norm;
  return out;
}

const localEmbedder: Embedder = {
  name: "local-hashing-1024",
  dim: LOCAL_DIM,
  async embed(texts) {
    return texts.map(localEmbed);
  },
};

function openAiEmbedder(apiKey: string): Embedder {
  const model = "text-embedding-3-small";
  return {
    name: `openai:${model}`,
    dim: 1536,
    async embed(texts) {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        throw new Error(`embeddings API ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      return json.data.map((d) => d.embedding);
    },
  };
}

const key = process.env.OPENAI_API_KEY ?? process.env.EMBEDDINGS_API_KEY;
export const embedder: Embedder = key ? openAiEmbedder(key) : localEmbedder;

export function embeddingsProvider(): string {
  return embedder.name;
}

/** Cosine similarity for L2-normalized vectors reduces to a dot product. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
