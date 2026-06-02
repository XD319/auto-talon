import { z } from "zod";

import type { PreparedShellInput, SandboxService } from "../sandbox/sandbox-service.js";
import type {
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

import type { TerminalSessionManager } from "./terminal-session-manager.js";

const terminalStartSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional()
});

const terminalSessionSchema = z.object({
  sessionId: z.string().min(1)
});

const terminalWriteSchema = terminalSessionSchema.extend({
  data: z.string()
});

export class TerminalStartTool implements ToolDefinition<typeof terminalStartSchema, PreparedShellInput> {
  public readonly name = "terminal_start";
  public readonly description = "Start a long-running terminal command and return a session id for later reads or stop.";
  public readonly capability = "shell.execute" as const;
  public readonly riskLevel = "high" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "moderate" as const;
  public readonly sideEffectLevel = "external_mutation" as const;
  public readonly approvalDefault = "always" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = terminalStartSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      env: { type: "object" }
    },
    required: ["command"],
    type: "object"
  };

  public constructor(
    private readonly manager: TerminalSessionManager,
    private readonly sandboxService: SandboxService
  ) {}

  public checkAvailability(): ToolAvailabilityResult {
    return { available: true, reason: "terminal session manager available" };
  }

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedShellInput> {
    const parsedInput = this.inputSchema.parse(input);
    const sandboxRequest: { command: string; cwd: string; env?: Record<string, string> } = {
      command: parsedInput.command,
      cwd: parsedInput.cwd ?? context.cwd
    };
    if (parsedInput.env !== undefined) {
      sandboxRequest.env = parsedInput.env;
    }
    const preparedInput = this.sandboxService.prepareShellExecution(sandboxRequest);

    return {
      governance: {
        pathScope: preparedInput.sandboxPlan.pathScope,
        summary: `Start terminal command ${preparedInput.command}`
      },
      preparedInput,
      sandbox: preparedInput.sandboxPlan
    };
  }

  public execute(input: PreparedShellInput): Promise<ToolExecutionResult> {
    const session = this.manager.start({
      command: input.command,
      cwd: input.cwd,
      env: input.env
    });
    return Promise.resolve({
      output: { ...session },
      success: true,
      summary: `Started terminal session ${session.sessionId}.`
    });
  }
}

export class TerminalReadTool implements ToolDefinition<typeof terminalSessionSchema, { sessionId: string }> {
  public readonly name = "terminal_read";
  public readonly description = "Read buffered stdout/stderr from a terminal session.";
  public readonly capability = "shell.execute" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "none" as const;
  public readonly approvalDefault = "never" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = terminalSessionSchema;
  public readonly inputSchemaDescriptor = sessionDescriptor();

  public constructor(private readonly manager: TerminalSessionManager) {}

  public prepare(input: unknown): ToolPreparation<{ sessionId: string }> {
    const preparedInput = this.inputSchema.parse(input);
    return createSessionPreparation(preparedInput, `Read terminal session ${preparedInput.sessionId}`);
  }

  public execute(input: { sessionId: string }): Promise<ToolExecutionResult> {
    const output = this.manager.read(input.sessionId);
    return Promise.resolve({
      output: { ...output },
      success: true,
      summary: `Read terminal session ${input.sessionId}.`
    });
  }
}

export class TerminalWriteTool implements ToolDefinition<typeof terminalWriteSchema, { data: string; sessionId: string }> {
  public readonly name = "terminal_write";
  public readonly description = "Write stdin data to a running terminal session.";
  public readonly capability = "shell.execute" as const;
  public readonly riskLevel = "high" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "external_mutation" as const;
  public readonly approvalDefault = "when_needed" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = terminalWriteSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      data: { type: "string" },
      sessionId: { type: "string" }
    },
    required: ["sessionId", "data"],
    type: "object"
  };

  public constructor(private readonly manager: TerminalSessionManager) {}

  public prepare(input: unknown): ToolPreparation<{ data: string; sessionId: string }> {
    const preparedInput = this.inputSchema.parse(input);
    return createSessionPreparation(preparedInput, `Write to terminal session ${preparedInput.sessionId}`);
  }

  public execute(input: { data: string; sessionId: string }): Promise<ToolExecutionResult> {
    const output = this.manager.write(input.sessionId, input.data);
    return Promise.resolve({
      output: { ...output },
      success: true,
      summary: `Wrote to terminal session ${input.sessionId}.`
    });
  }
}

export class TerminalStopTool implements ToolDefinition<typeof terminalSessionSchema, { sessionId: string }> {
  public readonly name = "terminal_stop";
  public readonly description = "Stop a running terminal session.";
  public readonly capability = "shell.execute" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "external_mutation" as const;
  public readonly approvalDefault = "when_needed" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = terminalSessionSchema;
  public readonly inputSchemaDescriptor = sessionDescriptor();

  public constructor(private readonly manager: TerminalSessionManager) {}

  public prepare(input: unknown): ToolPreparation<{ sessionId: string }> {
    const preparedInput = this.inputSchema.parse(input);
    return createSessionPreparation(preparedInput, `Stop terminal session ${preparedInput.sessionId}`);
  }

  public execute(input: { sessionId: string }): Promise<ToolExecutionResult> {
    const output = this.manager.stop(input.sessionId);
    return Promise.resolve({
      output: { ...output },
      success: true,
      summary: `Stopped terminal session ${input.sessionId}.`
    });
  }
}

function createSessionPreparation<TPreparedInput>(
  preparedInput: TPreparedInput,
  summary: string
): ToolPreparation<TPreparedInput> {
  return {
    governance: {
      pathScope: "workspace",
      summary
    },
    preparedInput,
    sandbox: {
      kind: "prompt",
      pathScope: "workspace",
      target: "interactive_user"
    }
  };
}

function sessionDescriptor(): {
  properties: { sessionId: { type: "string" } };
  required: string[];
  type: "object";
} {
  return {
    properties: {
      sessionId: { type: "string" }
    },
    required: ["sessionId"],
    type: "object"
  };
}
