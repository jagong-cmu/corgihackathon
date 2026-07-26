import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server binds to 0.0.0.0 so the container port can be exposed for testing.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
  },
});
