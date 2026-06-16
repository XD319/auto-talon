import { describe, expect, it } from "vitest";

import { buildChildEnv } from "../src/tools/shell/shell-executor.js";

describe("mcp stdio child env", () => {
  it("strips sensitive provider keys from inherited environment", () => {
    const env = buildChildEnv(
      {
        OPENAI_API_KEY: "secret",
        AGENT_PROVIDER_API_KEY: "secret",
        PATH: "/usr/bin"
      },
      { CUSTOM: "ok" }
    );
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AGENT_PROVIDER_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CUSTOM).toBe("ok");
  });
});
