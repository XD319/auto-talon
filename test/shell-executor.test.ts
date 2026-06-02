import { describe, expect, it } from "vitest";

import { resolveDefaultShellConfig } from "../src/tools/shell/shell-executor.js";

describe("shell executor backend resolution", () => {
  it("resolves explicit command shell backends", () => {
    expect(resolveDefaultShellConfig("cmd")).toMatchObject({
      args: ["/d", "/s", "/c"]
    });
    expect(resolveDefaultShellConfig("powershell")).toMatchObject({
      args: ["-NoProfile", "-Command"]
    });
    expect(resolveDefaultShellConfig("wsl")).toEqual({
      args: ["--exec", "/bin/sh", "-lc"],
      executable: "wsl.exe"
    });
  });

  it("keeps default behavior platform-specific", () => {
    const config = resolveDefaultShellConfig("default");
    expect(config.args.length).toBeGreaterThan(0);
    expect(config.executable.length).toBeGreaterThan(0);
  });
});
