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
  mode: z.enum(["matches", "files", "count"]).default("matches"),
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
  mode: CodeSearchMode;
  plan: SandboxFileAccessPlan;
  query: string;
  regex: boolean;
  searchFilenames: boolean;
}

type CodeSearchMode = "matches" | "files" | "count";

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

interface FileCount extends JsonObject {
  count: number;
  path: string;
  relativePath: string;
}

export interface CodeSearchToolOptions {
  runRgFiles?: (directoryPath: string, input: PreparedCodeSearchInput) => Promise<string[] | null>;
}

export class CodeSearchTool implements ToolDefinition<typeof codeSearchSchema, PreparedCodeSearchInput> {
  public readonly name = "search_files";
  public readonly description =
    "Search workspace code with literal or regex matching, optional glob filters, filename search, and context lines.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "read_only" as const;
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
        mode: parsedInput.mode,
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
    const fileCounts = new Map<string, FileCount>();
    const matchedFiles = new Map<string, string>();

    for (const filePath of files) {
      if (context.signal.aborted || shouldStopSearch(input, matches, filenameMatches, matchedFiles)) {
        break;
      }
      const relativePath = toRelativePath(context.workspaceRoot, filePath);
      if (input.searchFilenames && matcher.test(relativePath)) {
        if (input.mode === "matches" && matches.length + filenameMatches.length < input.maxResults) {
          filenameMatches.push({ path: filePath, relativePath });
        }
        addMatchedFile(matchedFiles, relativePath, filePath);
        incrementFileCount(fileCounts, relativePath, filePath);
        matcher.lastIndex = 0;
      }
      const fileMatches = await searchFile(filePath, relativePath, matcher, input, context.signal);
      for (const match of fileMatches) {
        if (input.mode === "matches" && matches.length + filenameMatches.length < input.maxResults) {
          matches.push(match);
        }
        addMatchedFile(matchedFiles, relativePath, filePath);
        incrementFileCount(fileCounts, relativePath, filePath);
        if (shouldStopSearch(input, matches, filenameMatches, matchedFiles)) {
          break;
        }
      }
    }

    const modeOutput = buildModeOutput(input.mode, {
      fileCounts: [...fileCounts.values()],
      filenameMatches,
      matchedFiles: [...matchedFiles.entries()].map(([relativePath, path]) => ({ path, relativePath })),
      matches,
      maxResults: input.maxResults
    });

    return {
      output: {
        ...modeOutput,
        path: input.plan.resolvedPath,
        query: input.query,
        regex: input.regex,
        searchBackend: Array.isArray(fileDiscovery) ? "node" : fileDiscovery.backend,
        searchedFileCount: files.length
      },
      success: true,
      summary: summarizeSearchResult(input.mode, input.query, modeOutput)
    };
  }
}

function shouldStopSearch(
  input: PreparedCodeSearchInput,
  matches: CodeSearchMatch[],
  filenameMatches: FilenameMatch[],
  matchedFiles: Map<string, string>
): boolean {
  if (input.mode === "matches") {
    return matches.length + filenameMatches.length >= input.maxResults;
  }
  return false;
}

function addMatchedFile(matchedFiles: Map<string, string>, relativePath: string, path: string): void {
  if (!matchedFiles.has(relativePath)) {
    matchedFiles.set(relativePath, path);
  }
}

function incrementFileCount(fileCounts: Map<string, FileCount>, relativePath: string, path: string): void {
  const existing = fileCounts.get(relativePath);
  if (existing === undefined) {
    fileCounts.set(relativePath, {
      count: 1,
      path,
      relativePath
    });
    return;
  }
  existing.count += 1;
}

function buildModeOutput(
  mode: CodeSearchMode,
  input: {
    fileCounts: FileCount[];
    filenameMatches: FilenameMatch[];
    matchedFiles: FilenameMatch[];
    matches: CodeSearchMatch[];
    maxResults: number;
  }
): JsonObject {
  if (mode === "files") {
    return {
      fileCount: Math.min(input.matchedFiles.length, input.maxResults),
      files: input.matchedFiles.slice(0, input.maxResults),
      truncated: input.matchedFiles.length > input.maxResults
    };
  }
  if (mode === "count") {
    return {
      fileCounts: input.fileCounts.slice(0, input.maxResults),
      totalMatchCount: input.fileCounts.reduce((total, item) => total + item.count, 0),
      truncated: input.fileCounts.length > input.maxResults
    };
  }
  return {
    filenameMatches: input.filenameMatches,
    matchCount: input.matches.length,
    matches: input.matches,
    truncated: input.matches.length + input.filenameMatches.length >= input.maxResults
  };
}

function summarizeSearchResult(mode: CodeSearchMode, query: string, output: JsonObject): string {
  if (mode === "files") {
    return `Found ${String(output.fileCount)} matching files for "${query}"`;
  }
  if (mode === "count") {
    return `Found ${String(output.totalMatchCount)} total matches for "${query}"`;
  }
  const matchCount = typeof output.matchCount === "number" ? output.matchCount : 0;
  const filenameMatches = Array.isArray(output.filenameMatches) ? output.filenameMatches.length : 0;
  return `Found ${matchCount} content matches and ${filenameMatches} filename matches for "${query}"`;
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
  const entries = (await fs.readdir(directoryPath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    if (signal.aborted) {
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
  const maxFileMatches =
    input.mode === "count" ? Number.POSITIVE_INFINITY : input.mode === "files" ? 1 : input.maxResults;
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
    if (matches.length >= maxFileMatches) {
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
