import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Runtime integration tests touch process-wide shell/env state, so serial files are more stable in CI.
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
