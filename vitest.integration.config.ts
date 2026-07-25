import { defineConfig } from "vitest/config";
import path from "path";

// Integration tests - hit the real staging deployment and real staging
// Postgres (RLS included). Requires .env.test (loaded via dotenv-cli in the
// npm script, not here) and runs cleanup before/after the whole run.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["./tests/integration/globalSetup.ts"],
    testTimeout: 45000, // real network calls to Anthropic/Voyage/Sarvam/Twilio/Postgres
    hookTimeout: 30000,
    // Test files share real, rate-limited external APIs (Voyage AI's free
    // tier is 3 requests/minute) - running files in parallel causes
    // spurious failures from hitting that limit, not from real bugs.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
