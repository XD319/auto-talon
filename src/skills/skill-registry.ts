import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, platform as currentPlatform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  attachmentKindFromDirectory,
  createAttachment,
  createEmptyAttachmentManifest,
  parseSkillAsset
} from "./skill-asset.js";
import type {
  LoadedSkillAttachment,
  SkillAsset,
  SkillAttachment,
  SkillAttachmentKind,
  SkillAttachmentManifest,
  SkillLayerPrecedence,
  SkillLayerSource,
  SkillListResult,
  SkillMetadata,
  SkillPlatform,
  SkillRegistryIssue,
  SkillSource,
  SkillView
} from "../types/index.js";
import { DEFAULT_SKILL_LAYER_PRECEDENCE } from "../types/index.js";

export interface RemoteSkillSource {
  listMetadata(): SkillListResult;
  view(skillId: string, attachmentKinds?: SkillAttachmentKind[]): SkillView | null;
}

export interface SkillRegistryOptions {
  builtinSkillsRoot?: string;
  env?: Record<string, string | undefined>;
  localSkillsRoot?: string;
  platform?: NodeJS.Platform;
  precedence?: SkillLayerPrecedence;
  remoteSources?: RemoteSkillSource[];
  teamSkillRoots?: string[];
  workspaceRoot: string;
}

interface SkillOverrideFile {
  disabledSkillIds: string[];
}

interface RegistryCandidate {
  asset: SkillAsset;
  pluginName?: string;
  sourceRoot: string;
}

export class SkillRegistry {
  private readonly builtinSkillsRoot: string;
  private readonly env: Record<string, string | undefined>;
  private readonly localSkillsRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly precedence: SkillLayerPrecedence;
  private readonly projectSkillsRoot: string;
  private readonly repoSkillRoots: string[];
  private readonly pluginSkillRoots: Array<{ pluginName: string; root: string }>;
  private readonly remoteSources: RemoteSkillSource[];
  private readonly teamSkillRoots: string[];
  private readonly workspaceRoot: string;

  public constructor(options: SkillRegistryOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.projectSkillsRoot = join(this.workspaceRoot, ".auto-talon", "skills");
    this.repoSkillRoots = collectAgentsSkillRoots(this.workspaceRoot);
    this.pluginSkillRoots = collectPluginSkillRoots(this.workspaceRoot);
    this.localSkillsRoot = resolve(
      options.localSkillsRoot ?? process.env.AGENT_SKILLS_HOME ?? join(homedir(), ".auto-talon", "skills")
    );
    this.builtinSkillsRoot = resolve(options.builtinSkillsRoot ?? defaultBuiltinSkillsRoot());
    this.teamSkillRoots = resolveTeamSkillRoots(options.teamSkillRoots);
    this.precedence = normalizePrecedence(options.precedence);
    this.platform = options.platform ?? currentPlatform();
    this.env = options.env ?? process.env;
    this.remoteSources = options.remoteSources ?? [];
  }

  public listSkills(): SkillListResult {
    const scan = this.scan();
    return {
      issues: scan.issues,
      skills: scan.skills.map((candidate) => candidate.asset.metadata)
    };
  }

  public viewSkill(skillId: string, attachmentKinds: SkillAttachmentKind[] = []): SkillView | null {
    const scan = this.scan();
    const candidate = scan.skills.find((entry) => entry.asset.metadata.id === skillId);
    if (candidate === undefined) {
      for (const remote of this.remoteSources) {
        const remoteView = remote.view(skillId, attachmentKinds);
        if (remoteView !== null) {
          return remoteView;
        }
      }
      return null;
    }

    const loadedAttachments = attachmentKinds.flatMap((kind) =>
      candidate.asset.attachments[kind].map((attachment) =>
        this.loadAttachment(candidate.asset.rootPath, attachment)
      )
    );

    return {
      ...candidate.asset,
      loadedAttachments
    };
  }

  public disableSkill(skillId: string): SkillListResult {
    const scan = this.scan({ includeDisabled: true });
    const candidate = scan.skills.find((entry) => entry.asset.metadata.id === skillId);
    if (candidate?.asset.metadata.required === true) {
      const issues = [
        ...scan.issues,
        {
          code: "required_locked" as const,
          detail: `Skill ${skillId} is required and cannot be disabled.`,
          path: candidate.asset.rootPath,
          skillId
        }
      ];
      return {
        issues,
        skills: this.listSkills().skills
      };
    }

    const overrides = this.readOverrides();
    if (!overrides.disabledSkillIds.includes(skillId)) {
      overrides.disabledSkillIds.push(skillId);
      this.writeOverrides(overrides);
    }
    return this.listSkills();
  }

  public enableSkill(skillId: string): SkillListResult {
    const overrides = this.readOverrides();
    if (overrides.disabledSkillIds.includes(skillId)) {
      overrides.disabledSkillIds = overrides.disabledSkillIds.filter((entry) => entry !== skillId);
      this.writeOverrides(overrides);
    }
    return this.listSkills();
  }

  private scan(options: { includeDisabled?: boolean } = {}): {
    issues: SkillRegistryIssue[];
    skills: RegistryCandidate[];
  } {
    const issues: SkillRegistryIssue[] = [];
    const overrides = this.readOverrides();
    const layerCandidates = this.collectLayerCandidates(issues);
    const selected = new Map<string, RegistryCandidate>();

    for (const layer of this.precedence) {
      for (const candidate of layerCandidates.get(layer) ?? []) {
        const key = logicalSkillKey(candidate.asset.metadata);
        const existing = selected.get(key);
        if (existing !== undefined) {
          issues.push({
            code: "duplicate_shadowed",
            detail: `${layer} skill ${candidate.asset.metadata.id} shadows ${existing.asset.metadata.id}.`,
            path: existing.asset.rootPath,
            skillId: existing.asset.metadata.id
          });
        }
        selected.set(key, candidate);
      }
    }

    const pluginCandidates = this.pluginSkillRoots.flatMap(({ pluginName, root }) =>
      this.scanRoot(root, "plugin", issues, pluginName)
    );
    for (const candidate of pluginCandidates) {
      const key = pluginLogicalSkillKey(candidate.pluginName ?? "unknown", candidate.asset.metadata);
      selected.set(key, candidate);
    }

    const filtered = [...selected.values()].filter((candidate) =>
      this.isUsable(
        candidate.asset.metadata,
        overrides,
        candidate.asset.rootPath,
        issues,
        options.includeDisabled === true
      )
    );

    for (const remote of this.remoteSources) {
      const remoteResult = remote.listMetadata();
      issues.push(...remoteResult.issues);
      for (const metadata of remoteResult.skills) {
        if (this.isUsable(metadata, overrides, metadata.id, issues, options.includeDisabled === true)) {
          filtered.push({
            asset: {
              attachments: createEmptyAttachmentManifest(),
              body: "",
              metadata,
              rootPath: metadata.id,
              skillPath: metadata.id
            },
            sourceRoot: metadata.id
          });
        }
      }
    }

    return {
      issues,
      skills: filtered.sort((left, right) => left.asset.metadata.id.localeCompare(right.asset.metadata.id))
    };
  }

  private collectLayerCandidates(
    issues: SkillRegistryIssue[]
  ): Map<SkillLayerSource, RegistryCandidate[]> {
    const map = new Map<SkillLayerSource, RegistryCandidate[]>();
    map.set("builtin", this.scanRoot(this.builtinSkillsRoot, "builtin", issues));
    map.set("local", this.scanRoot(this.localSkillsRoot, "local", issues));
    map.set(
      "project",
      [
        ...this.repoSkillRoots.flatMap((root) => this.scanRoot(root, "project", issues)),
        ...this.scanRoot(this.projectSkillsRoot, "project", issues)
      ]
    );
    map.set(
      "team",
      this.teamSkillRoots.flatMap((root) => this.scanRoot(root, "team", issues))
    );
    return map;
  }

  private scanRoot(
    sourceRoot: string,
    source: Extract<SkillSource, "local" | "project" | "team" | "builtin" | "plugin">,
    issues: SkillRegistryIssue[],
    pluginName?: string
  ): RegistryCandidate[] {
    const root = resolve(sourceRoot);
    if (!existsSync(root)) {
      return [];
    }

    return listSkillDirectories(root).flatMap((skillRoot) => {
      try {
        assertWithinRoot(skillRoot, root);
        const skillPath = join(skillRoot, "SKILL.md");
        if (!existsSync(skillPath)) {
          issues.push({
            code: "invalid_skill",
            detail: "Skill directory does not contain SKILL.md.",
            path: skillRoot,
            skillId: null
          });
          return [];
        }

        const asset = parseSkillAsset({
          attachments: this.discoverAttachments(skillRoot, issues),
          markdown: readFileSync(skillPath, "utf8"),
          rootPath: skillRoot,
          skillPath,
          source
        });

        if (source === "plugin" && pluginName !== undefined) {
          asset.metadata.id = `plugin:${pluginName}/${asset.metadata.namespace}/${asset.metadata.name}`;
        }

        return [
          {
            asset,
            ...(pluginName !== undefined ? { pluginName } : {}),
            sourceRoot: root
          }
        ];
      } catch (error) {
        issues.push({
          code: "invalid_skill",
          detail: error instanceof Error ? error.message : String(error),
          path: skillRoot,
          skillId: null
        });
        return [];
      }
    });
  }

  private discoverAttachments(skillRoot: string, issues: SkillRegistryIssue[]): SkillAttachmentManifest {
    const manifest = createEmptyAttachmentManifest();
    for (const directory of listDirectories(skillRoot)) {
      const kind = attachmentKindFromDirectory(directory);
      if (kind === null) {
        continue;
      }
      for (const filePath of listFilesRecursive(directory)) {
        try {
          assertWithinRoot(filePath, skillRoot);
          manifest[kind].push(createAttachment(kind, toPortableRelativePath(skillRoot, filePath)));
        } catch (error) {
          issues.push({
            code: "path_unsafe",
            detail: error instanceof Error ? error.message : String(error),
            path: filePath,
            skillId: null
          });
        }
      }
    }
    return manifest;
  }

  private isUsable(
    metadata: SkillMetadata,
    overrides: SkillOverrideFile,
    path: string,
    issues: SkillRegistryIssue[],
    includeDisabled = false
  ): boolean {
    const overrideDisabled = overrides.disabledSkillIds.includes(metadata.id);
    if ((metadata.disabled || overrideDisabled) && !metadata.required) {
      issues.push({
        code: "disabled",
        detail: `Skill ${metadata.id} is disabled.`,
        path,
        skillId: metadata.id
      });
      if (!includeDisabled) {
        return false;
      }
    }

    if (!isPlatformCompatible(metadata.platforms, this.platform)) {
      issues.push({
        code: "platform_incompatible",
        detail: `Skill ${metadata.id} does not support platform ${this.platform}.`,
        path,
        skillId: metadata.id
      });
      return false;
    }

    const missing = [...metadata.prerequisites.credentials, ...metadata.prerequisites.env].filter(
      (key) => this.env[key] === undefined || this.env[key]?.trim().length === 0
    );
    if (missing.length > 0) {
      issues.push({
        code: "credential_missing",
        detail: `Skill ${metadata.id} is missing prerequisites: ${missing.join(", ")}.`,
        path,
        skillId: metadata.id
      });
      return false;
    }

    if ((metadata.disabled || overrideDisabled) && metadata.required) {
      // Required skills ignore disable overrides and remain usable.
      return true;
    }

    if (metadata.disabled || overrideDisabled) {
      return includeDisabled;
    }

    return true;
  }

  private loadAttachment(skillRoot: string, attachment: SkillAttachment): LoadedSkillAttachment {
    const resolvedPath = resolve(skillRoot, attachment.path);
    assertWithinRoot(resolvedPath, skillRoot);
    return {
      ...attachment,
      content: readFileSync(resolvedPath, "utf8")
    };
  }

  private readOverrides(): SkillOverrideFile {
    const path = this.overridePath();
    if (!existsSync(path)) {
      return {
        disabledSkillIds: []
      };
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SkillOverrideFile;
    if (!Array.isArray(parsed.disabledSkillIds)) {
      throw new Error(`Invalid skill override file: ${path}`);
    }
    return parsed;
  }

  private writeOverrides(overrides: SkillOverrideFile): void {
    const path = this.overridePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
  }

  private overridePath(): string {
    return join(this.workspaceRoot, ".auto-talon", "skill-overrides.json");
  }
}

function listDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

function listSkillDirectories(root: string): string[] {
  return listDirectories(root).flatMap((directory) => {
    if (existsSync(join(directory, "SKILL.md"))) {
      return [directory];
    }
    return listDirectories(directory).filter((child) => existsSync(join(child, "SKILL.md")));
  });
}

function listFilesRecursive(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursive(path) : [path];
  });
}

function assertWithinRoot(candidatePath: string, rootPath: string): void {
  const candidate = resolve(candidatePath);
  const root = resolve(rootPath);
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes("..\\")) {
    throw new Error(`Path ${candidate} is outside root ${root}.`);
  }
}

function toPortableRelativePath(rootPath: string, candidatePath: string): string {
  return relative(rootPath, candidatePath).replace(/\\/gu, "/");
}

function logicalSkillKey(metadata: SkillMetadata): string {
  return `${metadata.namespace}/${metadata.name}`;
}

function pluginLogicalSkillKey(pluginName: string, metadata: SkillMetadata): string {
  return `plugin:${pluginName}/${metadata.namespace}/${metadata.name}`;
}

function isPlatformCompatible(platforms: SkillPlatform[], platform: NodeJS.Platform): boolean {
  return platforms.includes("any") || platforms.includes(toSkillPlatform(platform));
}

function toSkillPlatform(platform: NodeJS.Platform): SkillPlatform {
  if (platform === "win32") {
    return "windows";
  }
  if (platform === "darwin") {
    return "darwin";
  }
  return "linux";
}

function collectAgentsSkillRoots(workspaceRoot: string): string[] {
  const roots: string[] = [];
  let candidate = resolve(workspaceRoot);
  while (true) {
    const skillRoot = join(candidate, ".agents", "skills");
    if (existsSync(skillRoot)) {
      roots.push(skillRoot);
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }
  return roots.reverse();
}

function collectPluginSkillRoots(workspaceRoot: string): Array<{ pluginName: string; root: string }> {
  const pluginsRoot = join(workspaceRoot, ".auto-talon", "plugins");
  if (!existsSync(pluginsRoot)) {
    return [];
  }
  return listDirectories(pluginsRoot)
    .map((pluginRoot) => ({
      pluginName: relative(pluginsRoot, pluginRoot).replace(/\\/gu, "/"),
      root: join(pluginRoot, "skills")
    }))
    .filter((entry) => existsSync(entry.root));
}

function resolveTeamSkillRoots(configured?: string[]): string[] {
  const fromEnv = process.env.AGENT_TEAM_SKILLS_HOME?.trim();
  const roots = [
    ...(configured ?? []),
    ...(fromEnv !== undefined && fromEnv.length > 0 ? [fromEnv] : [])
  ];
  return [...new Set(roots.map((root) => resolve(root)))];
}

function normalizePrecedence(precedence?: SkillLayerPrecedence): SkillLayerPrecedence {
  if (precedence === undefined || precedence.length === 0) {
    return [...DEFAULT_SKILL_LAYER_PRECEDENCE];
  }
  const unique: SkillLayerSource[] = [];
  for (const layer of precedence) {
    if (!unique.includes(layer)) {
      unique.push(layer);
    }
  }
  for (const layer of DEFAULT_SKILL_LAYER_PRECEDENCE) {
    if (!unique.includes(layer)) {
      unique.push(layer);
    }
  }
  return unique;
}

function defaultBuiltinSkillsRoot(): string {
  // src/skills -> package root /skills (or dist/skills sibling when running compiled)
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "skills"),
    join(here, "..", "..", "assets", "builtin-skills"),
    join(here, "..", "skills")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}
