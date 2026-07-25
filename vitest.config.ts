import { defineConfig } from "vitest/config";
import path from "path";

// Unit tests only - pure functions, zero external dependencies, no .env.test
// needed. Integration tests live in vitest.integration.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
