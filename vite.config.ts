import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { whiteboardApiPlugin } from "./server/vitePlugin";

// The dev server binds to 0.0.0.0 so the container port can be exposed for testing.
// On GitHub Pages the app is served under /<repo>/, so set a base path there
// (PAGES=true in the deploy workflow). Locally/tunnel it stays at "/".
export default defineConfig({
  base: process.env.PAGES ? "/corgihackathon/" : "/",
  plugins: [react(), whiteboardApiPlugin()],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    // Allow the app to be served through dev tunnels (e.g. *.trycloudflare.com).
    allowedHosts: true,
    proxy: {
      // The persona/voice/avatar API (apps/api, FastAPI). Same origin from the
      // browser's point of view — no CORS. The UI degrades gracefully when the
      // API isn't running.
      "/tutor-api": {
        target: process.env.TUTOR_API_URL ?? "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tutor-api/, ""),
      },
    },
  },
});
