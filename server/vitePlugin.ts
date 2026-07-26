/**
 * Vite dev plugin: mounts the backend on the SAME dev server (and thus the same
 * public tunnel). Handles:
 *   POST /api/turn   -> { spokenText, visualSpec }  (Phase 2, live LLM)
 *   GET  /api/health -> { llm: boolean, merge: {...} } (Phase 3 will fill merge)
 *
 * This keeps the frontend on one origin — no CORS, no second process.
 */
import type { Plugin, Connect } from "vite";
import { runTurn } from "./turn";
import { llmAvailable } from "./llm";
import { checkContentBodyAvailable } from "./merge";

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function whiteboardApiPlugin(): Plugin {
  return {
    name: "whiteboard-api",
    configureServer(server) {
      server.middlewares.use("/api/turn", async (req, res, next) => {
        if (req.method !== "POST") return next();
        try {
          const body = await readBody(req);
          const { userQuery, retrievedContext } = JSON.parse(body || "{}");
          if (!userQuery || typeof userQuery !== "string") {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "userQuery (string) is required" }));
            return;
          }
          const result = await runTurn({ userQuery, retrievedContext });
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ...result, llm: llmAvailable() }));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });

      server.middlewares.use("/api/health", async (_req, res) => {
        const merge = await checkContentBodyAvailable();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, llm: llmAvailable(), merge }));
      });
    },
  };
}
