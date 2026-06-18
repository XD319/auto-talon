import type { ProviderRouter } from "../providers/routing/provider-router.js";
import type { Provider } from "../types/index.js";
import type { WebPageSummarizer, WebPageSummarizerInput } from "./web-fetch-tool.js";

export class ProviderWebPageSummarizer implements WebPageSummarizer {
  public constructor(
    private readonly providerRouter: ProviderRouter,
    private readonly fallbackProvider: Provider,
    private readonly options: { maxInputTokens: number } = { maxInputTokens: 32_000 }
  ) {}

  public async summarize(input: WebPageSummarizerInput): Promise<string> {
    const helperSelection = this.providerRouter.selectProvider({
      kind: "summarize",
      sessionId: null,
      taskId: "web-extract"
    });
    const helperProvider = helperSelection.provider ?? this.fallbackProvider;
    const response = await helperProvider.generate({
      agentProfileId: "planner",
      availableTools: [],
      iteration: 1,
      memoryContext: [],
      messages: [
        {
          content: buildWebPageSummarizerSystemPrompt(input),
          role: "system"
        },
        {
          content: buildWebPageSummarizerUserPrompt(input),
          role: "user"
        }
      ],
      signal: input.signal,
      task: {
        agentProfileId: "planner",
        createdAt: "",
        currentIteration: 1,
        cwd: "",
        errorCode: null,
        errorMessage: null,
        finalOutput: null,
        finishedAt: null,
        input: input.url,
        maxIterations: 1,
        metadata: {},
        providerName: helperProvider.name,
        requesterUserId: "system",
        startedAt: null,
        status: "running",
        taskId: "web-extract",
        sessionId: null,
        tokenBudget: {
          inputLimit: this.options.maxInputTokens,
          outputLimit: 2_000,
          reservedOutput: 200,
          usedCostUsd: 0,
          usedInput: 0,
          usedOutput: 0
        },
        updatedAt: ""
      },
      tokenBudget: {
        inputLimit: this.options.maxInputTokens,
        outputLimit: 2_000,
        reservedOutput: 200,
        usedCostUsd: 0,
        usedInput: 0,
        usedOutput: 0
      }
    });
    if (response.kind !== "final" || response.message.trim().length === 0) {
      throw new Error(`Web page summarizer returned an invalid response (kind=${response.kind}).`);
    }
    return response.message.trim();
  }
}

function buildWebPageSummarizerSystemPrompt(input: WebPageSummarizerInput): string {
  if (input.prompt !== undefined) {
    return [
      "Answer the user's extraction prompt using only the following web page.",
      `Target length: about ${input.targetBytes} bytes of plain text.`,
      "Preserve key evidence, factual claims, URLs, headings, and technical details.",
      "If the page does not contain the requested information, say that explicitly.",
      "Return plain text only. No markdown fences."
    ].join(" ");
  }
  return [
    "Summarize the following web page for another agent.",
    `Target length: about ${input.targetBytes} bytes of plain text.`,
    "Preserve factual claims, URLs, headings, and key technical details.",
    "Return plain text only. No markdown fences."
  ].join(" ");
}

function buildWebPageSummarizerUserPrompt(input: WebPageSummarizerInput): string {
  return [
    `URL: ${input.url}`,
    `Title: ${input.title}`,
    ...(input.prompt !== undefined ? ["", `Extraction prompt: ${input.prompt}`] : []),
    "",
    input.markdown
  ].join("\n");
}
