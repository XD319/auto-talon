import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ToolDefinition } from "../types/index.js";

import type { ToolsetName } from "../types/index.js";
import { resolveToolsetForTool } from "./toolsets.js";

interface ToolOverrideFile {
  disabledToolNames: string[];
}

export interface ToolListEntry {
  description: string;
  disabled: boolean;
  name: string;
  toolset: ToolsetName;
}

export interface ToolListResult {
  tools: ToolListEntry[];
}

export class ToolOverrideStore {
  public constructor(private readonly workspaceRoot: string) {}

  public listTools(registeredTools: ToolDefinition[]): ToolListResult {
    const disabledToolNames = new Set(this.readOverrides().disabledToolNames);
    return {
      tools: registeredTools
        .map((tool) => ({
          description: tool.description,
          disabled: disabledToolNames.has(tool.name),
          name: tool.name,
          toolset: resolveToolsetForTool(tool.name)
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    };
  }

  public listDisabledToolNames(): string[] {
    return [...this.readOverrides().disabledToolNames].sort();
  }

  public disableTool(toolName: string, registeredTools: ToolDefinition[]): ToolListResult {
    this.assertRegistered(toolName, registeredTools);
    const overrides = this.readOverrides();
    if (!overrides.disabledToolNames.includes(toolName)) {
      overrides.disabledToolNames.push(toolName);
      this.writeOverrides(overrides);
    }
    return this.listTools(registeredTools);
  }

  public enableTool(toolName: string, registeredTools: ToolDefinition[]): ToolListResult {
    this.assertRegistered(toolName, registeredTools);
    const overrides = this.readOverrides();
    if (overrides.disabledToolNames.includes(toolName)) {
      overrides.disabledToolNames = overrides.disabledToolNames.filter((entry) => entry !== toolName);
      this.writeOverrides(overrides);
    }
    return this.listTools(registeredTools);
  }

  private assertRegistered(toolName: string, registeredTools: ToolDefinition[]): void {
    if (!registeredTools.some((tool) => tool.name === toolName)) {
      throw new Error(`Tool ${toolName} is not registered.`);
    }
  }

  private readOverrides(): ToolOverrideFile {
    const path = this.overridePath();
    if (!existsSync(path)) {
      return {
        disabledToolNames: []
      };
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ToolOverrideFile;
    if (!Array.isArray(parsed.disabledToolNames)) {
      throw new Error(`Invalid tool override file: ${path}`);
    }
    return parsed;
  }

  private writeOverrides(overrides: ToolOverrideFile): void {
    const path = this.overridePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
  }

  private overridePath(): string {
    return join(this.workspaceRoot, ".auto-talon", "tool-overrides.json");
  }
}
