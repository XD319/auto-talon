import { existsSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { basename, join, relative } from "node:path";

export interface RepoMap {
  importantFiles: string[];
  languages: string[];
  packageManager: string | null;
  scripts: Record<string, string>;
  summary: string;
  workspaceRoot: string;
}

const IGNORED_DIRS = new Set([
  ".git",
  ".auto-talon",
  "dist",
  "node_modules",
  "coverage"
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".json", "JSON"],
  [".md", "Markdown"],
  [".py", "Python"],
  [".rs", "Rust"],
  [".go", "Go"]
]);

export function buildRepoMap(workspaceRoot: string): RepoMap {
  const files = listRepoFiles(workspaceRoot, workspaceRoot, 160);
  const languages = detectLanguages(files);
  const packageJsonPath = join(workspaceRoot, "package.json");
  const packageJson = readPackageJson(packageJsonPath);
  const packageManager = detectPackageManager(workspaceRoot, packageJson?.packageManager);
  const importantFiles = selectImportantFiles(files);
  const scripts = normalizeScripts(packageJson?.scripts);
  const summary = [
    `Repository map for ${basename(workspaceRoot) || workspaceRoot}.`,
    `Languages: ${languages.length === 0 ? "unknown" : languages.join(", ")}.`,
    `Package manager: ${packageManager ?? "unknown"}.`,
    `Important files: ${importantFiles.length === 0 ? "none" : importantFiles.join(", ")}.`,
    `Scripts: ${Object.keys(scripts).length === 0 ? "none" : Object.entries(scripts).map(([name, command]) => `${name}=${command}`).join("; ")}.`
  ].join(" ");

  return {
    importantFiles,
    languages,
    packageManager,
    scripts,
    summary,
    workspaceRoot
  };
}

function listRepoFiles(root: string, currentDir: string, limit: number): string[] {
  if (limit <= 0) {
    return [];
  }

  const entries = safeReadDir(currentDir);
  const files: string[] = [];
  for (const entry of entries) {
    if (files.length >= limit) {
      break;
    }
    if (IGNORED_DIRS.has(entry)) {
      continue;
    }

    const fullPath = join(currentDir, entry);
    const stat = safeStat(fullPath);
    if (stat === null) {
      continue;
    }
    const currentStat = stat;

    if (currentStat.isDirectory()) {
      files.push(...listRepoFiles(root, fullPath, limit - files.length));
      continue;
    }

    if (currentStat.isFile()) {
      files.push(relative(root, fullPath).replace(/\\/gu, "/"));
    }
  }

  return files.slice(0, limit);
}

function detectLanguages(files: string[]): string[] {
  const languages = new Set<string>();
  for (const file of files) {
    const extension = file.match(/\.[^.]+$/u)?.[0]?.toLowerCase();
    const language = extension === undefined ? undefined : LANGUAGE_BY_EXTENSION.get(extension);
    if (language !== undefined) {
      languages.add(language);
    }
  }
  return [...languages].sort();
}

function selectImportantFiles(files: string[]): string[] {
  const preferred = [
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "tsconfig.json",
    "src/cli/index.ts",
    "src/runtime/bootstrap.ts",
    "src/runtime/execution-kernel.ts",
    "src/tui/chat-app.tsx"
  ];
  const fileSet = new Set(files);
  return preferred.filter((file) => fileSet.has(file));
}

function readPackageJson(path: string): { packageManager?: unknown; scripts?: unknown } | null {
  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, "utf8")) as { packageManager?: unknown; scripts?: unknown };
}

function detectPackageManager(workspaceRoot: string, packageManager: unknown): string | null {
  if (typeof packageManager === "string" && packageManager.length > 0) {
    return packageManager;
  }
  if (existsSync(join(workspaceRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(workspaceRoot, "package-lock.json"))) {
    return "npm";
  }
  if (existsSync(join(workspaceRoot, "yarn.lock"))) {
    return "yarn";
  }
  return null;
}

function normalizeScripts(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
