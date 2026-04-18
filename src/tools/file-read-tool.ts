import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

import { z } from "zod";

import type { SandboxService } from "../sandbox/sandbox-service";
import { AppError } from "../runtime/app-error";
import type {
  SandboxFileAccessPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types";

const fileReadSchema = z
  .object({
    action: z.enum(["list_dir", "read_file", "search_text"]),
    keyword: z.string().min(1).optional(),
    maxResults: z.number().int().positive().max(100).default(20),
    path: z.string().min(1).optional(),
    recursive: z.boolean().default(true)
  })
  .superRefine((value, context) => {
    if ((value.action === "list_dir" || value.action === "read_file") && value.path === undefined) {
      context.addIssue({
        code: "custom",
        message: "path is required for list_dir and read_file."
      });
    }

    if (value.action === "search_text" && value.keyword === undefined) {
      context.addIssue({
        code: "custom",
        message: "keyword is required for search_text."
      });
    }
  });

type PreparedFileReadInput =
  | {
      action: "read_file";
      plan: SandboxFileAccessPlan;
    }
  | {
      action: "list_dir";
      plan: SandboxFileAccessPlan;
    }
  | {
      action: "search_text";
      keyword: string;
      maxResults: number;
      plan: SandboxFileAccessPlan;
      recursive: boolean;
    };

export class FileReadTool implements ToolDefinition<typeof fileReadSchema, PreparedFileReadInput> {
  public readonly name = "file_read";
  public readonly description =
    "Read a file, list a directory, or search text inside the workspace.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly inputSchema = fileReadSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      action: {
        enum: ["list_dir", "read_file", "search_text"],
        type: "string"
      },
      keyword: {
        type: "string"
      },
      maxResults: {
        type: "number"
      },
      path: {
        type: "string"
      },
      recursive: {
        type: "boolean"
      }
    },
    required: ["action"],
    type: "object"
  };

  public constructor(private readonly sandboxService: SandboxService) {}

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<PreparedFileReadInput> {
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareFileRead(parsedInput.path ?? ".", context.cwd);

    if (parsedInput.action === "read_file") {
      return {
        governance: {
          pathScope: plan.pathScope,
          summary: `Read file ${plan.resolvedPath}`
        },
        preparedInput: {
          action: parsedInput.action,
          plan
        },
        sandbox: plan
      };
    }

    if (parsedInput.action === "list_dir") {
      return {
        governance: {
          pathScope: plan.pathScope,
          summary: `List directory ${plan.resolvedPath}`
        },
        preparedInput: {
          action: parsedInput.action,
          plan
        },
        sandbox: plan
      };
    }

    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Search text in ${plan.resolvedPath}`
      },
      preparedInput: {
        action: parsedInput.action,
        keyword: parsedInput.keyword ?? "",
        maxResults: parsedInput.maxResults,
        plan,
        recursive: parsedInput.recursive
      },
      sandbox: plan
    };
  }

  public async execute(
    input: PreparedFileReadInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    if (input.action === "read_file") {
      return this.readFile(input);
    }

    if (input.action === "list_dir") {
      return this.listDirectory(input);
    }

    return this.searchText(input, context);
  }

  private async readFile(
    input: Extract<PreparedFileReadInput, { action: "read_file" }>
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    const content = await fs.readFile(targetPath, "utf8");

    return {
      output: {
        content,
        path: targetPath
      },
      success: true,
      summary: `Read ${basename(targetPath)}`
    };
  }

  private async listDirectory(
    input: Extract<PreparedFileReadInput, { action: "list_dir" }>
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    const entries = await fs.readdir(targetPath, { withFileTypes: true });

    return {
      output: {
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file"
        })),
        path: targetPath
      },
      success: true,
      summary: `Listed ${entries.length} entries from ${basename(targetPath)}`
    };
  }

  private async searchText(
    input: Extract<PreparedFileReadInput, { action: "search_text" }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const searchRoot = input.plan.resolvedPath;
    const matches: Array<{ line: string; lineNumber: number; path: string }> = [];

    await this.walkAndSearch(searchRoot, input.keyword, input, matches, context.signal);

    return {
      output: {
        keyword: input.keyword,
        matches,
        path: searchRoot
      },
      success: true,
      summary: `Found ${matches.length} matches for "${input.keyword}"`
    };
  }

  private async walkAndSearch(
    directoryPath: string,
    keyword: string,
    input: Extract<PreparedFileReadInput, { action: "search_text" }>,
    matches: Array<{ line: string; lineNumber: number; path: string }>,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) {
      throw new AppError({
        code: "interrupt",
        message: "File search interrupted."
      });
    }

    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= input.maxResults) {
        return;
      }

      const nextPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (input.recursive) {
          await this.walkAndSearch(nextPath, keyword, input, matches, signal);
        }
        continue;
      }

      const stat = await fs.stat(nextPath);
      if (stat.size > 1_000_000) {
        continue;
      }

      try {
        const content = await fs.readFile(nextPath, "utf8");
        const lines = content.split(/\r?\n/u);
        for (const [index, line] of lines.entries()) {
          if (!line.includes(keyword)) {
            continue;
          }

          matches.push({
            line,
            lineNumber: index + 1,
            path: nextPath
          });

          if (matches.length >= input.maxResults) {
            return;
          }
        }
      } catch {
        continue;
      }
    }
  }
}
