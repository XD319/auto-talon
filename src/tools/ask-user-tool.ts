import { z } from "zod";

import type {
  ClarifyPromptOption,
  ClarifyPromptQuestion,
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation,
  ToolSchemaDescriptor
} from "../types/index.js";

const optionSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1).optional(),
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    preview: z.string().min(1).optional()
  })
]);

const questionSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1).optional(),
  options: z.array(optionSchema).default([]),
  multiSelect: z.boolean().default(false),
  allowCustomAnswer: z.boolean().default(true),
  placeholder: z.string().min(1).optional()
});

const askUserInputSchema = z
  .object({
    questions: z.array(questionSchema).min(1).optional(),
    question: z.string().min(1).optional(),
    options: z.array(optionSchema).optional(),
    multiSelect: z.boolean().default(false),
    allowCustomAnswer: z.boolean().default(true),
    placeholder: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    response: z.string().min(1).optional()
  })
  .refine((input) => input.questions !== undefined || input.question !== undefined, {
    message: "questions or question is required."
  });

const askUserSchema = z.preprocess(preprocessAskUserInput, askUserInputSchema);

type AskUserInput = z.infer<typeof askUserSchema>;

const optionDescriptor = {
  additionalProperties: false,
  properties: {
    description: { type: "string" },
    id: { type: "string" },
    label: { type: "string" },
    preview: { type: "string" }
  },
  required: ["label"],
  type: "object"
};

const askUserSchemaDescriptor: ToolSchemaDescriptor = {
  additionalProperties: false,
  properties: {
    questions: {
      items: {
        additionalProperties: false,
        properties: {
          allowCustomAnswer: { type: "boolean" },
          header: { type: "string" },
          multiSelect: { type: "boolean" },
          options: { items: optionDescriptor, type: "array" },
          placeholder: { type: "string" },
          question: { type: "string" }
        },
        required: ["question", "options"],
        type: "object"
      },
      type: "array"
    },
    reason: { type: "string" }
  },
  required: ["questions"],
  type: "object"
};

const legacyAskUserSchemaDescriptor: ToolSchemaDescriptor = {
  additionalProperties: false,
  properties: {
    allowCustomAnswer: { type: "boolean" },
    options: { items: optionDescriptor, type: "array" },
    placeholder: { type: "string" },
    question: { type: "string" },
    reason: { type: "string" }
  },
  required: ["question"],
  type: "object"
};

export interface PreparedAskUserInput {
  allowCustomAnswer: boolean;
  options: ClarifyPromptOption[];
  placeholder: string | null;
  question: string;
  questions: ClarifyPromptQuestion[];
  reason: string | null;
  response: string | null;
}

export class AskUserTool implements ToolDefinition<typeof askUserSchema, PreparedAskUserInput> {
  public constructor(
    public readonly name = "AskUserQuestion",
    private readonly descriptorMode: "canonical" | "legacy" = "canonical"
  ) {}

  public readonly description =
    "Ask the interactive TUI user clarifying question(s). Use this for user preferences or missing requirements, not tool permissions.";
  public readonly capability = "interaction.ask_user" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "none" as const;
  public readonly approvalDefault = "never" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = askUserSchema;

  public get inputSchemaDescriptor() {
    return this.descriptorMode === "legacy" ? legacyAskUserSchemaDescriptor : askUserSchemaDescriptor;
  }

  public checkAvailability(context: ToolExecutionContext): ToolAvailabilityResult {
    return context.taskMetadata?.["interactivePromptMode"] === "tui"
      ? { available: true, reason: "interactive TUI prompt mode enabled" }
      : { available: false, reason: "AskUserQuestion is only available in interactive chat TUI runs" };
  }

  public prepare(input: unknown): ToolPreparation<PreparedAskUserInput> {
    const parsed = this.inputSchema.parse(input);
    const normalized = normalizeAskUserInput(parsed);
    return {
      governance: {
        pathScope: "workspace",
        summary: normalized.question
      },
      preparedInput: normalized,
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
      errorMessage: "AskUserQuestion should be intercepted before execute.",
      success: false
    });
  }
}

function normalizeAskUserInput(input: AskUserInput): PreparedAskUserInput {
  const questions =
    input.questions !== undefined
      ? input.questions.map((question, questionIndex) => normalizeQuestion(question, questionIndex))
      : [
          normalizeQuestion(
            {
              allowCustomAnswer: input.allowCustomAnswer,
              multiSelect: input.multiSelect,
              options: input.options ?? [],
              placeholder: input.placeholder,
              question: input.question ?? ""
            },
            0
          )
        ];
  const firstQuestion = questions[0] as ClarifyPromptQuestion;
  return {
    allowCustomAnswer: firstQuestion.allowCustomAnswer,
    options: firstQuestion.options,
    placeholder: firstQuestion.placeholder,
    question: firstQuestion.question,
    questions,
    reason: input.reason ?? null,
    response: input.response ?? null
  };
}

function normalizeQuestion(
  question: z.infer<typeof questionSchema>,
  questionIndex: number
): ClarifyPromptQuestion {
  return {
    allowCustomAnswer: question.allowCustomAnswer,
    ...(question.header !== undefined ? { header: question.header } : {}),
    multiSelect: question.multiSelect,
    options: question.options.map((option, optionIndex) =>
      normalizeOption(option, questionIndex, optionIndex)
    ),
    placeholder: question.placeholder ?? null,
    question: question.question
  };
}

function normalizeOption(
  option: z.infer<typeof optionSchema>,
  questionIndex: number,
  optionIndex: number
): ClarifyPromptOption {
  if (typeof option === "string") {
    return {
      id: `q${questionIndex + 1}-option-${optionIndex + 1}`,
      label: option
    };
  }
  return {
    id: option.id ?? `q${questionIndex + 1}-option-${optionIndex + 1}`,
    label: option.label,
    ...(option.description !== undefined ? { description: option.description } : {}),
    ...(option.preview !== undefined ? { preview: option.preview } : {})
  };
}

function preprocessAskUserInput(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  const next: Record<string, unknown> = { ...input };
  if (typeof next["questions"] === "string") {
    next["questions"] = parseJsonString(next["questions"]);
  }
  const questions = next["questions"];
  if (Array.isArray(questions)) {
    next["questions"] = questions.map((question: unknown): unknown =>
      isRecord(question) ? preprocessQuestion(question) : question
    );
  }
  if ("options" in next) {
    next["options"] = preprocessOptions(next["options"]);
  }
  if ("allowCustomAnswer" in next) {
    next["allowCustomAnswer"] = preprocessBoolean(next["allowCustomAnswer"]);
  }
  if ("multiSelect" in next) {
    next["multiSelect"] = preprocessBoolean(next["multiSelect"]);
  }
  return next;
}

function preprocessQuestion(question: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...question };
  if ("options" in next) {
    next["options"] = preprocessOptions(next["options"]);
  }
  if ("allowCustomAnswer" in next) {
    next["allowCustomAnswer"] = preprocessBoolean(next["allowCustomAnswer"]);
  }
  if ("multiSelect" in next) {
    next["multiSelect"] = preprocessBoolean(next["multiSelect"]);
  }
  return next;
}

function preprocessOptions(options: unknown): unknown {
  if (typeof options === "string") {
    return parseJsonString(options);
  }
  return options;
}

function preprocessBoolean(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return value;
}

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
