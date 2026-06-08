import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, extname, join, relative, sep } from "node:path";

import { z } from "zod";

import { AppError } from "../core/app-error.js";
import type { SandboxService } from "../sandbox/sandbox-service.js";
import type {
  JsonObject,
  SandboxFileAccessPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const codeSearchSchema = z.object({
  caseSensitive: z.boolean().default(false),
  contextLines: z.preprocess(
    clampContextLines,
    z.number().int().min(0).max(5).default(2)
  ),
  excludeGlobs: z.array(z.string().min(1)).max(50).default([]),
  includeGlobs: z.array(z.string().min(1)).max(50).default([]),
  maxFileSizeBytes: z.number().int().positive().max(10_000_000).default(1_000_000),
  maxResults: z.number().int().positive().max(200).default(50),
  path: z.string().min(1).optional(),
  query: z.string().min(1),
  regex: z.boolean().default(false),
  searchFilenames: z.boolean().default(false)
});

const execFileAsync = promisify(execFile);

export interface PreparedCodeSearchInput {
  caseSensitive: boolean;
  contextLines: number;
  excludeGlobs: string[];
  includeGlobs: string[];
  maxFileSizeBytes: number;
  maxResults: number;
  plan: SandboxFileAccessPlan;
  query: string;
  regex: boolean;
  searchFilenames: boolean;
}

interface CodeSearchMatch extends JsonObject {
  afterContext: string[];
  beforeContext: string[];
  line: string;
  lineNumber: number;
  matchText: string;
  path: string;
  relativePath: string;
}

interface FilenameMatch extends JsonObject {
  path: string;
  relativePath: string;
}

export interface CodeSearchToolOptions {
  runRgFiles?: (directoryPath: string, input: PreparedCodeSearchInput) => Promise<string[] | null>;
}

export class CodeSearchTool implements ToolDefinition<typeof codeSearchSchema, PreparedCodeSearchInput> {
  public readonly name = "code_search";
  public readonly description =
    "Search workspace code with literal or regex matching, optional glob filters, filename search, and context lines.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "read_only" as const;
  public readonly approvalDefault = "never" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = codeSearchSchema;

  public constructor(
    private readonly sandboxService: SandboxService,
    private readonly options: CodeSearchToolOptions = {}
  ) {}

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedCodeSearchInput> {
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareFileRead(parsedInput.path ?? ".", context.cwd);
    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Search code in ${plan.resolvedPath}`
      },
      preparedInput: {
        caseSensitive: parsedInput.caseSensitive,
        contextLines: parsedInput.contextLines,
        excludeGlobs: parsedInput.excludeGlobs,
        includeGlobs: parsedInput.includeGlobs,
        maxFileSizeBytes: parsedInput.maxFileSizeBytes,
        maxResults: parsedInput.maxResults,
        plan,
        query: parsedInput.query,
        regex: parsedInput.regex,
        searchFilenames: parsedInput.searchFilenames
      },
      sandbox: plan
    };
  }

  public async execute(input: PreparedCodeSearchInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    let matcher: RegExp;
    try {
      matcher = input.regex
        ? new RegExp(input.query, input.caseSensitive ? "u" : "iu")
        : literalMatcher(input.query, input.caseSensitive);
    } catch (error) {
      return {
        details: {
          query: input.query,
          regex: input.regex
        },
        errorCode: "tool_validation_error",
        errorMessage: error instanceof Error ? `Invalid regex: ${error.message}` : "Invalid regex.",
        success: false
      };
    }

    const stat = await fs.stat(input.plan.resolvedPath);
    const fileDiscovery = stat.isDirectory()
      ? await collectFiles(input.plan.resolvedPath, input, context.signal, this.options.runRgFiles)
      : [input.plan.resolvedPath];
    const files = Array.isArray(fileDiscovery) ? fileDiscovery : fileDiscovery.files;
    const matches: CodeSearchMatch[] = [];
    const filenameMatches: FilenameMatch[] = [];

    for (const filePath of files) {
      if (context.signal.aborted || matches.length + filenameMatches.length >= input.maxResults) {
        break;
      }
      const relativePath = toRelativePath(context.workspaceRoot, filePath);
      if (input.searchFilenames && matcher.test(relativePath)) {
        filenameMatches.push({ path: filePath, relativePath });
        matcher.lastIndex = 0;
      }
      const fileMatches = await searchFile(filePath, relativePath, matcher, input, context.signal);
      for (const match of fileMatches) {
        matches.push(match);
        if (matches.length + filenameMatches.length >= input.maxResults) {
          break;
        }
      }
    }

    return {
      output: {
        filenameMatches,
        matchCount: matches.length,
        matches,
        path: input.plan.resolvedPath,
        query: input.query,
        regex: input.regex,
        searchBackend: Array.isArray(fileDiscovery) ? "node" : fileDiscovery.backend,
        searchedFileCount: files.length,
        truncated: matches.length + filenameMatches.length >= input.maxResults
      },
      success: true,
      summary: `Found ${matches.length} content matches and ${filenameMatches.length} filename matches for "${input.query}"`
    };
  }
}

async function collectFiles(
  directoryPath: string,
  input: PreparedCodeSearchInput,
  signal: AbortSignal,
  runRgFiles?: (directoryPath: string, input: PreparedCodeSearchInput) => Promise<string[] | null>
): Promise<{ backend: "node" | "rg"; files: string[] }> {
  if (signal.aborted) {
    throw new AppError({
      code: "interrupt",
      message: "Code search interrupted."
    });
  }
  const rgFiles = await (runRgFiles ?? defaultRunRgFiles)(directoryPath, input);
  if (rgFiles !== null) {
    return {
      backend: "rg",
      files: await filterCandidateFiles(directoryPath, rgFiles, input, signal)
    };
  }

  return {
    backend: "node",
    files: await collectFilesWithNode(directoryPath, input, signal)
  };
}

async function collectFilesWithNode(
  directoryPath: string,
  input: PreparedCodeSearchInput,
  signal: AbortSignal
): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (signal.aborted || files.length >= input.maxResults) {
      break;
    }
    const nextPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        continue;
      }
      files.push(...(await collectFilesWithNode(nextPath, input, signal)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativePath = toRelativePath(input.plan.resolvedPath, nextPath);
    if (!passesGlobFilters(relativePath, input.includeGlobs, input.excludeGlobs)) {
      continue;
    }
    const stat = await fs.stat(nextPath);
    if (stat.size > input.maxFileSizeBytes || isLikelyBinaryPath(nextPath)) {
      continue;
    }
    files.push(nextPath);
  }
  return files;
}

async function defaultRunRgFiles(
  directoryPath: string,
  input: PreparedCodeSearchInput
): Promise<string[] | null> {
  const args = [
    "--files",
    "--hidden",
    ...[...IGNORED_DIRECTORIES].flatMap((directory) => ["--glob", `!${directory}/**`]),
    ...input.includeGlobs.flatMap((glob) => ["--glob", normalizePath(glob)]),
    ...input.excludeGlobs.flatMap((glob) => ["--glob", `!${normalizePath(glob)}`])
  ];

  try {
    const result = await execFileAsync("rg", args, {
      cwd: directoryPath,
      encoding: "utf8",
      maxBuffer: 5_000_000,
      windowsHide: true
    });
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => join(directoryPath, line));
  } catch {
    return null;
  }
}

async function filterCandidateFiles(
  rootPath: string,
  files: string[],
  input: PreparedCodeSearchInput,
  signal: AbortSignal
): Promise<string[]> {
  const filtered: string[] = [];
  for (const filePath of files) {
    if (signal.aborted) {
      break;
    }
    const relativePath = toRelativePath(rootPath, filePath);
    if (!passesGlobFilters(relativePath, input.includeGlobs, input.excludeGlobs)) {
      continue;
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > input.maxFileSizeBytes || isLikelyBinaryPath(filePath)) {
        continue;
      }
      filtered.push(filePath);
    } catch {
      continue;
    }
  }
  return filtered;
}

async function searchFile(
  filePath: string,
  relativePath: string,
  matcher: RegExp,
  input: PreparedCodeSearchInput,
  signal: AbortSignal
): Promise<CodeSearchMatch[]> {
  if (signal.aborted) {
    return [];
  }
  const relativeToRoot = toRelativePath(input.plan.resolvedPath, filePath);
  if (!passesGlobFilters(relativeToRoot, input.includeGlobs, input.excludeGlobs)) {
    return [];
  }
  const stat = await fs.stat(filePath);
  if (stat.size > input.maxFileSizeBytes || isLikelyBinaryPath(filePath)) {
    return [];
  }
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  if (content.includes("\u0000")) {
    return [];
  }
  const lines = content.split(/\r?\n/u);
  const matches: CodeSearchMatch[] = [];
  for (const [index, line] of lines.entries()) {
    matcher.lastIndex = 0;
    const match = matcher.exec(line);
    if (match === null) {
      continue;
    }
    matches.push({
      afterContext: lines.slice(index + 1, index + 1 + input.contextLines),
      beforeContext: lines.slice(Math.max(0, index - input.contextLines), index),
      line,
      lineNumber: index + 1,
      matchText: match[0],
      path: filePath,
      relativePath
    });
    if (matches.length >= input.maxResults) {
      break;
    }
  }
  return matches;
}

function literalMatcher(query: string, caseSensitive: boolean): RegExp {
  return new RegExp(escapeRegExp(query), caseSensitive ? "u" : "iu");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function passesGlobFilters(relativePath: string, includeGlobs: string[], excludeGlobs: string[]): boolean {
  const normalized = normalizePath(relativePath);
  if (excludeGlobs.some((pattern) => globToRegExp(pattern).test(normalized))) {
    return false;
  }
  if (includeGlobs.length === 0) {
    return true;
  }
  return includeGlobs.some((pattern) => globToRegExp(pattern).test(normalized));
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
        continue;
      }
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  return new RegExp(`^${source}$`, "u");
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function toRelativePath(root: string, path: string): string {
  const relativePath = relative(root, path);
  return normalizePath(relativePath.length === 0 ? basename(path) : relativePath);
}

function clampContextLines(value: unknown): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value;
  }
  return Math.min(value, 5);
}

function isLikelyBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp"
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bmp",
  ".class",
  ".dll",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".so",
  ".webp",
  ".zip"
]);
