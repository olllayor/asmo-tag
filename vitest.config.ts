import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [".delta/**", "node_modules/**", "dist/**"],
    // Store and view tests drive hundreds of sequential SQLite transactions, so a
    // case that runs under two seconds alone can pass five seconds when every
    // file runs at once. A per-test timeout measures the runner, not the test.
    testTimeout: 20_000,
  },
});
