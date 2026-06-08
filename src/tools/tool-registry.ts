import type { ToolDefinition } from "../types/index.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  public register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  public registerAll(tools: ToolDefinition[]): this {
    for (const tool of tools) {
      this.register(tool);
    }
    return this;
  }

  public get(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName);
  }

  public list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  public has(toolName: string): boolean {
    return this.tools.has(toolName);
  }
}
