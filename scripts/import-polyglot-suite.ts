/**
 * Turn the Aider polyglot Python exercises into an AutoTalon eval suite.
 *
 * .meta/ holds the official solution and is never copied. .docs/ becomes the
 * task prompt, not a workspace file. The generated suite is gitignored.
 *
 * Usage:
 *   node --import tsx scripts/import-polyglot-suite.ts --source <polyglot-benchmark>
 * Optional:
 *   --output <path>   default fixtures/eval-suites/polyglot-python.v1.json
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DEFAULT_OUTPUT = "fixtures/eval-suites/polyglot-python.v1.json";
const PRACTICE = join("python", "exercises", "practice");

interface CliOptions {
  output: string;
  source: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { output: DEFAULT_OUTPUT, source: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--source") {
      if (next === undefined) throw new Error("--source requires a value");
      options.source = next;
      i += 1;
    } else if (arg === "--output") {
      if (next === undefined) throw new Error("--output requires a value");
      options.output = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function walk(root: string, dir: string, files: Record<string, string>): void {
  for (const entry of readdirSync(dir)) {
    if (entry === ".meta" || entry === ".docs" || entry === ".git") continue;
    const absolute = join(dir, entry);
    const info = statSync(absolute);
    if (info.isDirectory()) {
      walk(root, absolute, files);
      continue;
    }
    if (info.size > 200_000) continue;
    const text = readFileSync(absolute);
    if (text.includes(0)) continue;
    files[relative(root, absolute).replaceAll("\\", "/")] = text.toString("utf8");
  }
}

function readOracleFiles(dir: string): Record<string, string> {
  let config: { files?: { example?: string[]; solution?: string[] } };
  try {
    config = JSON.parse(readFileSync(join(dir, ".meta", "config.json"), "utf8")) as typeof config;
  } catch {
    return {};
  }
  const examples = config.files?.example ?? [];
  const solutions = config.files?.solution ?? [];
  if (examples.length !== 1 || solutions.length !== 1) {
    throw new Error(`${dir}: expected one example and one solution file`);
  }
  const example = examples[0];
  const solution = solutions[0];
  if (example === undefined || solution === undefined) {
    return {};
  }
  return { [solution]: readFileSync(join(dir, example), "utf8") };
}

function readDocs(dir: string): string {
  const docs = join(dir, ".docs");
  let text = "";
  try {
    for (const name of ["introduction.md", "instructions.md", "instructions.append.md"]) {
      try {
        text += `${readFileSync(join(docs, name), "utf8").trim()}\n\n`;
      } catch {
        // optional doc
      }
    }
  } catch {
    return "";
  }
  return text.trim();
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.source === null) {
    throw new Error("--source <polyglot-benchmark checkout> is required");
  }
  const practice = resolve(options.source, PRACTICE);
  const slugs = readdirSync(practice).filter((name) => statSync(join(practice, name)).isDirectory()).sort();
  if (slugs.length === 0) {
    throw new Error(`No exercises under ${practice}`);
  }
  const tasks = slugs.map((slug) => {
    const dir = join(practice, slug);
    const files: Record<string, string> = {};
    walk(dir, dir, files);
    const docs = readDocs(dir);
    const input = [
      docs.length > 0 ? docs : `Implement the Python exercise \`${slug}\`.`,
      "",
      "Edit the starter files so the existing tests pass.",
      "Do not modify the test files.",
      "Verify with a single `pytest` command (no shell chaining)."
    ].join("\n");
    return {
      approvalMode: "allow",
      capabilities: ["coding", "verification"],
      category: "coding",
      difficulty: "hard",
      id: `polyglot_python_${slug.replaceAll("-", "_")}`,
      input,
      profile: "executor",
      risk: "low",
      scorers: [
        {
          command: "pytest",
          expectedExitCode: 0,
          id: "pytest",
          required: true,
          timeoutMs: 300_000,
          type: "command"
        },
        {
          id: "source_only",
          type: "workspace_diff",
          required: true,
          allowedPaths: Object.keys(readOracleFiles(dir)),
          requiredPaths: Object.keys(readOracleFiles(dir)),
          ignoredDirectoryNames: [".pytest_cache", "__pycache__"]
        }
      ],
      oracle: {
        files: readOracleFiles(dir),
        output: `Implemented ${slug} so pytest passes.`
      },
      timeoutMs: 600_000,
      title: slug,
      workspace: { files }
    };
  });
  const suite = {
    description:
      "Aider polyglot Python subset (34 Exercism exercises). .meta solutions are excluded. Generated; do not commit.",
    id: "aider-polyglot-python",
    promptVersion: "runtime-0.1",
    schemaVersion: 1,
    tasks,
    toolSchemaVersion: "runtime-0.1",
    version: "1.1.0"
  };
  const output = resolve(options.output);
  writeFileSync(output, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
  console.error(`Wrote ${tasks.length} tasks to ${output}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
