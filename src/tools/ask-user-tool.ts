import { z } from "zod";

import type {
  ClarifyPromptOption,
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const askUserSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).optional(),
  allowCustomAnswer: z.boolean().default(true),
  placeholder: z.string().min(1).optional(),
  reason: z.string().min(1).optional()
});

export interface PreparedAskUserInput {
  allowCustomAnswer: boolean;
  options: ClarifyPromptOption[];
  placeholder: string | null;
  question: string;
  reason: string | null;
}

export class AskUserTool implements ToolDefinition<typeof askUserSchema, PreparedAskUserInput> {
  public readonly name = "ask_user";
  public readonly description = "Pause execution and ask the interactive TUI user for clarification.";
  public readonly capability = "interaction.ask_user" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "workspace_mutation" as const;
  public readonly approvalDefault = "never" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = askUserSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      allowCustomAnswer: { type: "boolean" },
      options: { type: "array" },
      placeholder: { type: "string" },
      question: { type: "string" },
      reason: { type: "string" }
    },
    required: ["question"],
    type: "object"
  };

  public checkAvailability(context: ToolExecutionContext): ToolAvailabilityResult {
    return context.taskMetadata?.["interactivePromptMode"] === "tui"
      ? { available: true, reason: "interactive TUI prompt mode enabled" }
      : { available: false, reason: "ask_user is only available in interactive chat TUI runs" };
  }

  public prepare(input: unknown): ToolPreparation<PreparedAskUserInput> {
    const parsed = this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "workspace",
        summary: parsed.question
      },
      preparedInput: {
        allowCustomAnswer: parsed.allowCustomAnswer,
        options: parsed.options ?? [],
        placeholder: parsed.placeholder ?? null,
        question: parsed.question,
        reason: parsed.reason ?? null
      },
      sandbox: {
        kind: "prompt",
        pathScope: "workspace",
        target: "interactive_user"
      }
    };
  }

  public execute(): Promise<ToolExecutionResult> {
    return Promise.resolve({
      errorCode: "invalid_state",
      errorMessage: "ask_user should be intercepted before execute.",
      success: false
    });
  }
}
