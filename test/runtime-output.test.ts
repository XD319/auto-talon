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

class SlowDeltaProvider implements Provider {
  public readonly name = "slow-delta-provider";

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    await delay(30);
    input.onTextDelta?.("still ");
    await delay(30);
    input.onTextDelta?.("working");
    return {
      kind: "final",
      message: "still working",
      usage: { inputTokens: 1, outputTokens: 2 }
    };
  }
}

class IdleProvider implements Provider {
  public readonly name = "idle-provider";

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    await new Promise<never>((_resolve, reject) => {
      input.signal.addEventListener(
        "abort",
        () =>
          reject(
            input.signal.reason instanceof Error
              ? input.signal.reason
              : new DOMException(String(input.signal.reason ?? "timeout"), "AbortError")
          ),
        { once: true }
      );
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

  it("keeps live output callbacks and task identity when continuing a thread", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-output-continue-"));
    tempPaths.push(workspace);
    await fs.writeFile(join(workspace, "README.md"), "runtime output", "utf8");
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new OutputProvider()
    });
    const continuedEvents: string[] = [];

    try {
      const firstOptions = createDefaultRunOptions("read then answer", workspace, handle.config);
      const first = await handle.service.runTask(firstOptions);
      const threadId = first.task.threadId;
      expect(threadId).not.toBeNull();

      const continued = await handle.service.continueThread(threadId!, "continue from plan", {
        cwd: workspace,
        onOutputEvent: (event) => continuedEvents.push(event.eventType),
        taskId: "continued-task-id",
        timeoutMode: "activity",
        timeoutMs: 900_000
      });

      expect(continued.task.taskId).toBe("continued-task-id");
      expect(continued.output).toBe("final answer");
      expect(continuedEvents).toContain("assistant_turn_started");
      expect(continuedEvents).toContain("assistant_turn_delta");
      const started = handle.service
        .traceTask("continued-task-id")
        .find((event) => event.eventType === "task_started");
      expect(started?.eventType === "task_started" ? started.payload.timeoutMode : null).toBe("activity");
      expect(started?.eventType === "task_started" ? started.payload.timeoutMs : null).toBe(900_000);
      expect(handle.service.outputTask("continued-task-id").some((event) => event.eventType === "result")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("keeps activity-mode tasks alive when assistant deltas arrive", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-output-activity-"));
    tempPaths.push(workspace);
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new SlowDeltaProvider()
    });

    try {
      const options = createDefaultRunOptions("slow streaming answer", workspace, handle.config);
      options.timeoutMode = "activity";
      options.timeoutMs = 50;

      const result = await handle.service.runTask(options);

      expect(result.output).toBe("still working");
      expect(result.task.status).toBe("succeeded");
    } finally {
      handle.close();
    }
  });

  it("returns timeout when activity-mode provider stays idle", async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "talon-output-idle-"));
    tempPaths.push(workspace);
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new IdleProvider()
    });

    try {
      const options = createDefaultRunOptions("idle provider", workspace, handle.config);
      options.timeoutMode = "activity";
      options.timeoutMs = 20;

      const result = await handle.service.runTask(options);
      const failure = handle.service
        .traceTask(result.task.taskId)
        .find((event) => event.eventType === "provider_request_failed");

      expect(result.error?.code).toBe("timeout");
      expect(result.error?.message).toBe("Task timed out after inactivity.");
      expect(failure?.eventType === "provider_request_failed" ? failure.payload.errorCategory : null).toBe(
        "timeout_error"
      );
      expect(failure?.eventType === "provider_request_failed" ? failure.payload.timeoutSource : null).toBe("activity");
    } finally {
      handle.close();
    }
  });
});

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
