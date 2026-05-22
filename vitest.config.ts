import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup-env.ts"],
    testTimeout: 30_000,
    coverage: {
      reporter: ["text", "html"],
      thresholds: {
        branches: 45,
        functions: 55,
        lines: 55,
        statements: 55
      }
    }
  }
});
