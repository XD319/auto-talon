import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15_000,
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
