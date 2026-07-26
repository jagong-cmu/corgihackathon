import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AccessToken } from "livekit-server-sdk";
import { defineConfig, type Plugin } from "vite";
import { MissingCredentialsError, liveKitCredentials, repoRoot } from "./scripts/env.ts";

const FIXTURE_DIR = join(repoRoot(), "packages", "canvas-protocol", "test", "fixtures");

/**
 * Dev-only endpoints. Both exist so the browser never sees a LiveKit secret
 * and never needs its own env file:
 *
 *   GET /api/token?room=&identity=  → { url, token } for a subscribe-only join
 *   GET /api/fixtures               → fixture names on disk
 *   GET /api/fixtures/:name         → one fixture, for the local replay path
 */
function devApi(): Plugin {
  return {
    name: "cue-inspector-dev-api",
    configureServer(server) {
      server.middlewares.use("/api/token", async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const room = url.searchParams.get("room") || "cue-inspector";
        const identity = url.searchParams.get("identity") || `inspector-${Date.now()}`;
        try {
          const creds = liveKitCredentials();
          const at = new AccessToken(creds.apiKey, creds.apiSecret, { identity, ttl: "2h" });
          // Subscribe-only: the inspector observes a session, it never joins it.
          at.addGrant({
            roomJoin: true,
            room,
            canSubscribe: true,
            canPublish: false,
            canPublishData: false,
          });
          json(res, 200, { url: creds.url, token: await at.toJwt(), identity, room });
        } catch (err) {
          const status = err instanceof MissingCredentialsError ? 503 : 500;
          json(res, status, { error: (err as Error).message });
        }
      });

      server.middlewares.use("/api/fixtures", (req, res) => {
        const path = (req.url ?? "/").split("?")[0].replace(/^\//, "");
        try {
          if (!path) {
            const names = readdirSync(FIXTURE_DIR)
              .filter((f) => f.endsWith(".json"))
              .map((f) => f.replace(/\.json$/, ""));
            json(res, 200, { fixtures: names });
            return;
          }
          if (!/^[a-z0-9-]+$/i.test(path)) {
            json(res, 400, { error: "bad fixture name" });
            return;
          }
          const body = readFileSync(join(FIXTURE_DIR, `${path}.json`), "utf8");
          res.setHeader("content-type", "application/json");
          res.end(body);
        } catch (err) {
          json(res, 404, { error: (err as Error).message });
        }
      });
    },
  };
}

function json(res: { setHeader(k: string, v: string): void; statusCode: number; end(b: string): void }, status: number, body: unknown) {
  res.setHeader("content-type", "application/json");
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

export default defineConfig({
  plugins: [devApi()],
  server: { port: 5178 },
  resolve: {
    alias: {
      // Resolve the protocol package to its TypeScript source rather than its
      // built dist. The schemas are the thing under test here — the inspector
      // should fail the moment the source changes shape, not the next time
      // somebody remembers to run a build.
      "@tutor/canvas-protocol": join(repoRoot(), "packages", "canvas-protocol", "src", "index.ts"),
    },
  },
});
