/**
 * Production server — serves the built frontend (dist/) AND the API on ONE
 * origin, so a deployed instance is always "live": the Anthropic key lives HERE,
 * server-side, and never touches the browser. This is what makes a hosted
 * deploy (Render/Railway/Fly/etc.) online-for-everyone with no per-user key.
 *
 * It mirrors server/vitePlugin.ts (same endpoints, same behaviour) but runs as
 * a plain Node http server instead of a Vite dev middleware.
 *
 *   Build:  npm run build          (produces dist/)
 *   Run:    npm start              (PORT env, default 8080)
 *   Env:    ANTHROPIC_API_KEY (required for live answers),
 *           optionally MERGE_*, LIVEKIT_* (see the respective modules).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { runTurn } from "./turn";
import { createLiveSession, liveKitConfigured } from "./live";
import { llmAvailable } from "./llm";
import { checkContentBodyAvailable, mergeSyncIngest, mergeConfigured } from "./merge";
import { ingestDocument, listMaterials, corpusSize, provider, retrieve } from "./rag";

const PORT = Number(process.env.PORT ?? 8080);
const DIST = join(process.cwd(), "dist");
const GROUNDING_MIN_SCORE = 0.05;
const TOP_K = 4;

function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
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

function json(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

/** Serve a built static asset, falling back to index.html for SPA routes. */
async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  let filePath = normalize(join(DIST, urlPath));
  // Prevent path traversal outside dist/.
  if (!filePath.startsWith(DIST)) {
    res.statusCode = 403;
    return void res.end("forbidden");
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(DIST, "index.html"); // SPA fallback
  }
  try {
    const buf = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader("content-type", CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream");
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}

/** Route /api/* exactly like the dev plugin. Returns true if it handled the req. */
async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = (req.url ?? "").split("?")[0];
  if (!url.startsWith("/api/")) return false;
  const method = req.method ?? "GET";

  try {
    if (url === "/api/turn") {
      if (method !== "POST") return (json(res, 405, { error: "POST only" }), true);
      const { userQuery, retrievedContext } = JSON.parse((await readBody(req)) || "{}");
      if (!userQuery || typeof userQuery !== "string") {
        return (json(res, 400, { error: "userQuery (string) is required" }), true);
      }
      let context: string[] | undefined = retrievedContext;
      let grounding = { used: false, sources: [] as string[], k: 0 };
      if (!context && corpusSize() > 0) {
        const hits = (await retrieve(userQuery, TOP_K)).filter((h) => h.score >= GROUNDING_MIN_SCORE);
        if (hits.length) {
          context = hits.map((h) => `[${h.fileName}] ${h.text}`);
          grounding = { used: true, sources: [...new Set(hits.map((h) => h.fileName))], k: hits.length };
        }
      }
      const result = await runTurn({ userQuery, retrievedContext: context });
      json(res, 200, { ...result, llm: llmAvailable(), grounding });
      return true;
    }

    if (url === "/api/ingest") {
      if (method !== "POST") return (json(res, 405, { error: "POST only" }), true);
      const parsed = JSON.parse((await readBody(req, 30_000_000)) || "{}") as {
        files?: { name: string; mimeType?: string; dataBase64: string }[];
      };
      const files = parsed.files ?? [];
      if (!files.length) return (json(res, 400, { error: "no files provided" }), true);
      const materials = [];
      for (const f of files) {
        const bytes = new Uint8Array(Buffer.from(f.dataBase64, "base64"));
        materials.push(await ingestDocument({ fileName: f.name, mimeType: f.mimeType, bytes }));
      }
      json(res, 200, { materials, provider: provider(), corpusSize: corpusSize() });
      return true;
    }

    if (url === "/api/materials") {
      const merge = await checkContentBodyAvailable();
      json(res, 200, { materials: listMaterials(), corpusSize: corpusSize(), provider: provider(), merge });
      return true;
    }

    if (url === "/api/merge/sync") {
      if (method !== "POST") return (json(res, 405, { error: "POST only" }), true);
      const materials = await mergeSyncIngest();
      json(res, 200, { configured: mergeConfigured(), ingested: materials.length, materials });
      return true;
    }

    if (url === "/api/live/session") {
      if (method !== "POST") return (json(res, 405, { error: "POST only" }), true);
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!liveKitConfigured()) {
        return (
          json(res, 503, {
            error:
              "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.",
          }),
          true
        );
      }
      json(res, 200, await createLiveSession(body));
      return true;
    }

    if (url === "/api/live/health") {
      json(res, 200, { configured: liveKitConfigured() });
      return true;
    }

    if (url === "/api/health") {
      const merge = await checkContentBodyAvailable();
      json(res, 200, {
        ok: true,
        llm: llmAvailable(),
        embeddings: provider(),
        corpusSize: corpusSize(),
        merge,
      });
      return true;
    }

    json(res, 404, { error: `unknown endpoint ${url}` });
    return true;
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
    return true;
  }
}

const server = createServer(async (req, res) => {
  try {
    if (await handleApi(req, res)) return;
    await serveStatic(req, res);
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Chalk production server listening on :${PORT} (llm=${llmAvailable()})`);
});
