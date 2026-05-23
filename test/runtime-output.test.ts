import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import { buildTranscriptRows } from "../src/tui/view-models/transcript-output.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class OutputProvider implements Provider {
  public readonly name = "output-provider";

  public generate(input: ProviderInput): Promise<ProviderResponse> {
    if (!input.messages.some((message) => message.role === "tool")) {
      input.onTextDelta?.("intermediate text");
      return Promise.resolve({
        kind: "tool_calls",
        message: "intermediate text",
        toolCalls: [
          {
            input: { action: "read_file", path: join(input.task.cwd, "README.md") },
            reason: "Read workspace context.",
            toolCallId: "read-output",
            toolName: "file_read"
          }
        ],
        usage: { inputTokens: 3, outputTokens: 2 }
      });
    }
    input.onTextDelta?.("final answer");
    return Promise.resolve({
      kind: "final",
      message: "final answer",
      usage: { inputTokens: 4, outputTokens: 2 }
    });
  }
}

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined) {
      await fs.rm(path, { force: true, recursive: true });
    }
  }
});

describe("runtime output events", () => {
  it("persists turn output and keeps intermediate tool turns out of final transcript rows", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-output-"));
    tempPaths.push(workspace);
    await fs.writeFile(join(workspace, "README.md"), "runtime output", "utf8");
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new OutputProvider()
    });
    const live: string[] = [];

    try {
      const options = createDefaultRunOptions("read then answer", workspace, handle.config);
      options.onOutputEvent = (event) => live.push(event.eventType);
      const result = await handle.service.runTask(options);
      const output = handle.service.outputTask(result.task.taskId);
      const completions = output.filter((event) => event.eventType === "assistant_turn_completed");
      const finalRows = buildTranscriptRows(output, { mode: "final" });
      const detailRows = buildTranscriptRows(output, { mode: "detail" });

      expect(result.output).toBe("final answer");
      expect(live).toContain("assistant_turn_delta");
      expect(completions.map((event) => event.payload.display)).toEqual(["intermediate", "final"]);
      expect(finalRows.map((row) => row.text)).toContain("final answer");
      expect(finalRows.map((row) => row.text)).not.toContain("intermediate text");
      expect(detailRows.map((row) => row.text)).toContain("intermediate text");
      expect(output.some((event) => event.eventType === "tool_status")).toBe(true);
      expect(output.at(-1)?.eventType).toBe("result");
      expect(handle.service.outputThread(result.task.threadId ?? "")).toHaveLength(output.length);
    } finally {
      handle.close();
    }
  });
});
