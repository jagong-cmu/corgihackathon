import { defineConfig } from "vitest/config";

/**
 * This package keeps its own config rather than inheriting the repo root's.
 *
 * Vitest walks up for the nearest config, so without this the canvas client's
 * root config wins and its `include` (src/**) matches nothing here — the suite
 * "passes" by finding no tests, which is the worst possible failure mode for
 * the file that guards the contract between the two tracks.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
