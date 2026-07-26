/**
 * Vite dev plugin: mounts the backend on the SAME dev server (and thus the same
 * public tunnel). Endpoints:
 *   POST /api/turn        -> { spokenText, visualSpec, llm, grounding }  (Phase 2 + 3)
 *   POST /api/ingest      -> ingest uploaded files (local fallback path)  (Phase 3)
 *   GET  /api/materials   -> corpus status + ingested docs                (Phase 3)
 *   POST /api/merge/sync  -> pull from Merge if configured, else no-op     (Phase 3)
 *   GET  /api/health      -> llm + embeddings provider + corpus + merge check
 *
 * One origin — no CORS, no second process.
 */
import type { Plugin, Connect } from "vite";
import { runTurn } from "./turn";
import { llmAvailable } from "./llm";
import { checkContentBodyAvailable, mergeSyncIngest, mergeConfigured } from "./merge";
import { ingestDocument, listMaterials, corpusSize, provider, retrieve } from "./rag";

// Minimum cosine score for a retrieved chunk to be treated as relevant.
const GROUNDING_MIN_SCORE = 0.05;
const TOP_K = 4;

function readBody(req: Connect.IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: Parameters<Connect.NextHandleFunction>[1], code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function whiteboardApiPlugin(): Plugin {
  return {
    name: "whiteboard-api",
    configureServer(server) {
      // ---- Live tutor turn, grounded in the corpus when relevant ----
      server.middlewares.use("/api/turn", async (req, res, next) => {
        if (req.method !== "POST") return next();
        try {
          const body = await readBody(req);
          const { userQuery, retrievedContext } = JSON.parse(body || "{}");
          if (!userQuery || typeof userQuery !== "string") {
            return json(res, 400, { error: "userQuery (string) is required" });
          }

          // Retrieve grounding chunks (unless the caller supplied context).
          let context: string[] | undefined = retrievedContext;
          let grounding = { used: false, sources: [] as string[], k: 0 };
          if (!context && corpusSize() > 0) {
            const hits = (await retrieve(userQuery, TOP_K)).filter(
              (h) => h.score >= GROUNDING_MIN_SCORE
            );
            if (hits.length) {
              context = hits.map((h) => `[${h.fileName}] ${h.text}`);
              grounding = {
                used: true,
                sources: [...new Set(hits.map((h) => h.fileName))],
                k: hits.length,
              };
            }
          }

          const result = await runTurn({ userQuery, retrievedContext: context });
          json(res, 200, { ...result, llm: llmAvailable(), grounding });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });

      // ---- Local file-upload ingestion (the Merge fallback path) ----
      server.middlewares.use("/api/ingest", async (req, res, next) => {
        if (req.method !== "POST") return next();
        try {
          const body = await readBody(req, 30_000_000); // ~30 MB
          const parsed = JSON.parse(body || "{}") as {
            files?: { name: string; mimeType?: string; dataBase64: string }[];
          };
          const files = parsed.files ?? [];
          if (!files.length) return json(res, 400, { error: "no files provided" });

          const materials = [];
          for (const f of files) {
            const bytes = new Uint8Array(Buffer.from(f.dataBase64, "base64"));
            materials.push(
              await ingestDocument({ fileName: f.name, mimeType: f.mimeType, bytes })
            );
          }
          json(res, 200, { materials, provider: provider(), corpusSize: corpusSize() });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });

      // ---- Corpus status ----
      server.middlewares.use("/api/materials", async (_req, res) => {
        const merge = await checkContentBodyAvailable();
        json(res, 200, {
          materials: listMaterials(),
          corpusSize: corpusSize(),
          provider: provider(),
          merge,
        });
      });

      // ---- Merge sync (live only; no-op + loud log otherwise) ----
      server.middlewares.use("/api/merge/sync", async (req, res, next) => {
        if (req.method !== "POST") return next();
        try {
          const materials = await mergeSyncIngest();
          json(res, 200, {
            configured: mergeConfigured(),
            ingested: materials.length,
            materials,
          });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });

      // ---- Health ----
      server.middlewares.use("/api/health", async (_req, res) => {
        const merge = await checkContentBodyAvailable();
        json(res, 200, {
          ok: true,
          llm: llmAvailable(),
          embeddings: provider(),
          corpusSize: corpusSize(),
          merge,
        });
      });
    },
  };
}
