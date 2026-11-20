// Module 5: the golden-set evals (npm run eval). They call the real model, so
// they're kept apart from npm test, which never needs a key.
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

if (existsSync(".env.local")) loadEnvFile(".env.local");

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 60 * 60 * 1000,
    env: { AI_CALLS_QUIET: "1" },
  },
});
