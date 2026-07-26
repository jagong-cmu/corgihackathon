import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// vitest/config re-exports vite's defineConfig with the `test` key typed.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The app is a pure SPA. There is no Node backend in this repo any more — the
 * only HTTP server is FastAPI in `apps/api`, and `/api` is proxied to it in
 * development so the browser stays same-origin and no CORS config exists
 * anywhere.
 *
 * On GitHub Pages the app is served under /<repo>/, so a base path is set there
 * (PAGES=true in the deploy workflow). Note that a Pages build is a shell only:
 * a lesson needs the API and the agent worker, neither of which is static.
 */
export default defineConfig({
  base: process.env.PAGES ? "/corgihackathon/" : "/",
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve the protocol package to its TypeScript source rather than a
      // built dist. The schemas are the contract between this client and the
      // agent — the app should break the moment the source changes shape, not
      // the next time somebody remembers to run a build.
      "@tutor/canvas-protocol": join(here, "packages", "canvas-protocol", "src", "index.ts"),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    // Allow the app to be served through dev tunnels (e.g. *.trycloudflare.com).
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env.TUTOR_API_URL ?? "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
