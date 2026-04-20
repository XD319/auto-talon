import { describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service";

describe("SandboxService", () => {
  it("denies shell command chaining syntax", () => {
    const sandboxService = new SandboxService({
      allowedShellCommands: ["echo"],
      workspaceRoot: process.cwd()
    });

    expect(() =>
      sandboxService.prepareShellExecution({
        command: "echo hi && whoami",
        cwd: process.cwd()
      })
    ).toThrow(/chaining or eval syntax/i);
  });

  it("denies node eval style arguments", () => {
    const sandboxService = new SandboxService({
      allowedShellCommands: ["node"],
      workspaceRoot: process.cwd()
    });

    expect(() =>
      sandboxService.prepareShellExecution({
        command: "node -e \"console.log('x')\"",
        cwd: process.cwd()
      })
    ).toThrow(/violate sandbox policy/i);
  });

  it("supports wildcard fetch host rules", () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["*.example.com"],
      workspaceRoot: process.cwd()
    });

    const plan = sandboxService.prepareWebFetch("https://docs.example.com/api");
    expect(plan.host).toBe("docs.example.com");
  });
});
