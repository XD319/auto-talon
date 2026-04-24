/* global console, process */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const gatewayRoot = join(repoRoot, "src", "gateway");

const allowedFiles = new Set([
  join(gatewayRoot, "runtime-facade.ts"),
  join(gatewayRoot, "bootstrap.ts")
]);

const violations = [];
for (const filePath of walkTsFiles(gatewayRoot)) {
  if (allowedFiles.has(filePath)) {
    continue;
  }
  const content = readFileSync(filePath, "utf8");
  if (content.includes("AgentApplicationService") || content.includes("applicationService")) {
    violations.push(relative(repoRoot, filePath));
  }
}

if (violations.length > 0) {
  console.error("Gateway facade bypass check failed. These files must not reference application service:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

function* walkTsFiles(directoryPath) {
  for (const entry of readdirSync(directoryPath)) {
    const fullPath = join(directoryPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      yield* walkTsFiles(fullPath);
      continue;
    }
    if (fullPath.endsWith(".ts")) {
      yield fullPath;
    }
  }
}
