import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [".delta/**", "node_modules/**", "dist/**"],
  },
});
