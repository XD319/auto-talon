import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 2,
    minWorkers: 1,
    pool: "threads",
    poolMatchGlobs: [
      ["**/cli-inbox.test.ts", "forks"],
      ["**/cli-memory-command.test.ts", "forks"],
      ["**/cli-schedule.test.ts", "forks"]
    ],
    setupFiles: ["./test/setup-env.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    coverage: {
      reporter: ["text", "html"],
      thresholds: {
        branches: 50,
        functions: 60,
        lines: 60,
        statements: 60
      }
    }
  }
});
