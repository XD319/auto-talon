import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplication, resolveAppConfig, resolveRuntimeConfig } from "../src/runtime/index.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";

const tempPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("runtime config", () => {
  it("defaults fetch hosts to open web_fetch and uses larger coding budgets", async () => {
    const workspaceRoot = await createTempWorkspace();
    const config = resolveRuntimeConfig(workspaceRoot);

    expect(config.allowedFetchHosts).toEqual(["*"]);
    expect(config.tokenBudget.inputLimit).toBe(64_000);
    expect(config.tokenBudget.outputLimit).toBe(8_000);

    const sandbox = new SandboxService({
      allowedFetchHosts: config.allowedFetchHosts,
      workspaceRoot
    });
    expect(sandbox.prepareWebFetch("https://not-example.test/doc").host).toBe("not-example.test");
    expect(() => sandbox.prepareWebFetch("http://127.0.0.1:11434/v1")).toThrow(/blocked for web fetch/i);
  });

  it("loads runtime.config.json and lets env override high-impact fields", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify(
        {
          allowedFetchHosts: ["github.com"],
          defaultMaxIterations: 5,
          defaultTimeoutMs: 45_000,
          workflow: {
            maxShellTimeoutMs: 90_000,
            shellBackend: "git-bash",
            testCommands: [
              {
                category: "test",
                command: "node check.js",
                name: "test",
                timeoutMs: 60_000
              }
            ]
          },
          tokenBudget: {
            inputLimit: 32_000,
            outputLimit: 4_000,
            reservedOutput: 500
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const fileConfig = resolveRuntimeConfig(workspaceRoot);
    expect(fileConfig.configSource).toBe("file");
    expect(fileConfig.allowedFetchHosts).toEqual(["github.com"]);
    expect(fileConfig.defaultMaxIterations).toBe(5);
    expect(fileConfig.workflow.maxShellTimeoutMs).toBe(90_000);
    expect(fileConfig.workflow.shellBackend).toBe("git-bash");
    expect(fileConfig.workflow.testCommands).toEqual([
      {
        category: "test",
        command: "node check.js",
        name: "test",
        timeoutMs: 60_000
      }
    ]);
    expect(fileConfig.tokenBudget.inputLimit).toBe(32_000);

    vi.stubEnv("AGENT_ALLOWED_FETCH_HOSTS", "docs.example.com,*.githubusercontent.com");
    vi.stubEnv("AGENT_SHELL_BACKEND", "cmd");
    vi.stubEnv("AGENT_SHELL_MAX_TIMEOUT_MS", "180000");
    vi.stubEnv("AGENT_TOKEN_INPUT_LIMIT", "128000");
    const envConfig = resolveRuntimeConfig(workspaceRoot);

    expect(envConfig.configSource).toBe("env");
    expect(envConfig.allowedFetchHosts).toEqual(["docs.example.com", "*.githubusercontent.com"]);
    expect(envConfig.workflow.shellBackend).toBe("cmd");
    expect(envConfig.workflow.maxShellTimeoutMs).toBe(180_000);
    expect(envConfig.tokenBudget.inputLimit).toBe(128_000);
    expect(envConfig.tokenBudget.outputLimit).toBe(4_000);
  });

  it("lets explicit createApplication config override resolved runtime config", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        allowedFetchHosts: ["github.com"],
        tokenBudget: {
          inputLimit: 32_000
        }
      }),
      "utf8"
    );

    const handle = createApplication(workspaceRoot, {
      config: {
        allowedFetchHosts: ["internal.example"],
        databasePath: ":memory:",
        tokenBudget: {
          inputLimit: 9_000,
          outputLimit: 3_000,
          reservedOutput: 300,
          usedInput: 0,
          usedOutput: 0
        }
      }
    });

    try {
      expect(handle.config.allowedFetchHosts).toEqual(["internal.example"]);
      expect(handle.config.tokenBudget.inputLimit).toBe(9_000);
    } finally {
      handle.close();
    }
  });

  it("fails fast for invalid token budget config", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        tokenBudget: {
          outputLimit: 1_000,
          reservedOutput: 1_000
        }
      }),
      "utf8"
    );

    expect(() => resolveRuntimeConfig(workspaceRoot)).toThrow(/reservedOutput/);
  });

  it("falls back to default workflow test commands when normalized list is empty", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        workflow: {
          testCommands: ["   ", "\t"]
        }
      }),
      "utf8"
    );

    const config = resolveRuntimeConfig(workspaceRoot);
    expect(config.workflow.testCommands).toEqual(["npm test", "npm run build"]);
  });

  it("resolves web search backend and Firecrawl key from runtime config and env", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        webSearch: {
          apiUrl: "https://firecrawl.example/v1/search",
          backend: "firecrawl",
          maxResults: 8
        }
      }),
      "utf8"
    );
    vi.stubEnv("FIRECRAWL_API_KEY", "fire-key");
    const fileConfig = resolveRuntimeConfig(workspaceRoot);
    expect(fileConfig.webSearch).toMatchObject({
      apiKey: "fire-key",
      apiUrl: "https://firecrawl.example/v1/search",
      backend: "firecrawl",
      maxResults: 8
    });

    vi.stubEnv("AGENT_WEB_SEARCH_BACKEND", "disabled");
    const envConfig = resolveRuntimeConfig(workspaceRoot);
    expect(envConfig.configSource).toBe("env");
    expect(envConfig.webSearch.backend).toBe("disabled");
  });

  it("reuses the nearest initialized parent workspace from nested directories", async () => {
    const workspaceRoot = await createTempWorkspace();
    const nestedCwd = join(workspaceRoot, "packages", "assistant", "src");
    delete process.env.AGENT_PROVIDER;
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "glm",
        providers: {
          glm: {
            apiKey: "parent-workspace-key"
          }
        }
      }),
      "utf8"
    );
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        version: 1
      }),
      "utf8"
    );
    await fs.mkdir(nestedCwd, { recursive: true });

    const config = resolveAppConfig(nestedCwd);

    expect(config.workspaceRoot).toBe(workspaceRoot);
    expect(config.provider.name).toBe("glm");
    await expect(fs.stat(join(nestedCwd, ".auto-talon"))).rejects.toThrow();
  });

  it("does not treat a provider-only parent config as an initialized workspace", async () => {
    const configParent = await createTempWorkspace();
    const nestedCwd = join(configParent, "work", "scratch");
    await fs.mkdir(join(configParent, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(configParent, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "glm"
      }),
      "utf8"
    );
    await fs.mkdir(nestedCwd, { recursive: true });

    const config = resolveAppConfig(nestedCwd);

    expect(config.workspaceRoot).toBe(nestedCwd);
  });

  it("lets AGENT_WORKSPACE_ROOT pin the workspace before parent discovery", async () => {
    const parentWorkspace = await createTempWorkspace();
    const explicitWorkspace = await createTempWorkspace();
    const nestedCwd = join(parentWorkspace, "nested");
    await fs.mkdir(join(parentWorkspace, ".auto-talon"), { recursive: true });
    await fs.mkdir(nestedCwd, { recursive: true });
    vi.stubEnv("AGENT_WORKSPACE_ROOT", explicitWorkspace);

    const config = resolveAppConfig(nestedCwd);

    expect(config.workspaceRoot).toBe(explicitWorkspace);
    await expect(fs.stat(join(nestedCwd, ".auto-talon"))).rejects.toThrow();
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-runtime-config-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
