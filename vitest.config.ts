import { configDefaults, defineConfig } from "vitest/config";

const forkPoolTests = [
  "test/cli-inbox.test.ts",
  "test/cli-memory-command.test.ts",
  "test/cli-schedule.test.ts"
];

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 2,
    minWorkers: 1,
    pool: "threads",
    projects: [
      {
        extends: true,
        test: {
          name: "threads",
          exclude: [...configDefaults.exclude, ...forkPoolTests],
          pool: "threads"
        }
      },
      {
        extends: true,
        test: {
          name: "forks",
          include: forkPoolTests,
          pool: "forks"
        }
      }
    ],
    setupFiles: ["./test/setup-env.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    coverage: {
      reporter: ["text", "html"],
      thresholds: {
        branches: 60,
        functions: 70,
        lines: 70,
        statements: 70
      }
    }
  }
});
