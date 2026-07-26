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
  },
});
