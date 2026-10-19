import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ShellTool } from "../src/tools/shell-tool.js";
import { PatchTool } from "../src/tools/patch-tool.js";
import { ReadFileTool } from "../src/tools/read-file-tool.js";
import { WriteFileTool } from "../src/tools/write-file-tool.js";
import { GlobTool } from "../src/tools/glob-tool.js";
import { CodeSearchTool } from "../src/tools/code-search-tool.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import {
  getToolInputSchemaDescriptor,
  zodSchemaToDescriptor
} from "../src/tools/schema/tool-schema.js";
import type { ToolSchemaDescriptor } from "../src/types/index.js";

describe("zodSchemaToDescriptor", () => {
  it("converts object schemas with required and optional fields", () => {
    const schema = z.object({
      command: z.string().min(1),
      cwd: z.string().min(1).optional(),
      allowNonZeroExit: z.boolean().default(false)
    });

    expect(zodSchemaToDescriptor(schema)).toEqual({
      properties: {
        allowNonZeroExit: { type: "boolean" },
        command: { minLength: 1, type: "string" },
        cwd: { minLength: 1, type: "string" }
      },
      required: ["command"],
      type: "object"
    });
  });

  it("converts array and enum fields", () => {
    const schema = z.object({
      tags: z.array(z.string()),
      mode: z.enum(["read", "write"])
    });

    expect(zodSchemaToDescriptor(schema)).toEqual({
      properties: {
        mode: { enum: ["read", "write"], type: "string" },
        tags: { items: { type: "string" }, type: "array" }
      },
      required: ["tags", "mode"],
      type: "object"
    });
  });

  it("wraps non-object root schemas in a value property", () => {
    expect(zodSchemaToDescriptor(z.string())).toEqual({
      properties: {
        value: { type: "string" }
      },
      required: ["value"],
      type: "object"
    });
  });

  it("converts literals to a single-member enum", () => {
    expect(zodSchemaToDescriptor(z.object({ action: z.literal("create") }))).toEqual({
      properties: {
        action: { enum: ["create"], type: "string" }
      },
      required: ["action"],
      type: "object"
    });
  });

  it("converts discriminated unions to anyOf variants instead of a bare string", () => {
    const schema = z.discriminatedUnion("action", [
      z.object({ action: z.literal("create"), name: z.string().min(1) }),
      z.object({ action: z.literal("remove"), scheduleId: z.string().min(1) })
    ]);

    expect(zodSchemaToDescriptor(schema)).toEqual({
      anyOf: [
        {
          properties: {
            action: { enum: ["create"], type: "string" },
            name: { minLength: 1, type: "string" }
          },
          required: ["action", "name"],
          type: "object"
        },
        {
          properties: {
            action: { enum: ["remove"], type: "string" },
            scheduleId: { minLength: 1, type: "string" }
          },
          required: ["action", "scheduleId"],
          type: "object"
        }
      ],
      type: "object"
    });
  });

  it("keeps scalar unions addressable through the value wrapper", () => {
    expect(zodSchemaToDescriptor(z.union([z.string(), z.number()]))).toEqual({
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "number" }], type: "string" }
      },
      required: ["value"],
      type: "object"
    });
  });
});

describe("getToolInputSchemaDescriptor", () => {
  it("derives shell tool descriptor from Zod schema", () => {
    const tool = new ShellTool(
      {
        execute: () => Promise.resolve({
          output: {},
          success: true,
          summary: "ok"
        })
      },
      new SandboxService({ workspaceRoot: process.cwd() })
    );

    const descriptor = getToolInputSchemaDescriptor(tool);
    expect(descriptor.type).toBe("object");
    expect(descriptor.properties?.command).toMatchObject({ type: "string", minLength: 1 });
    expect(descriptor.required).toContain("command");
  });

  it("prefers getInputSchemaDescriptor override when provided", () => {
    const override: ToolSchemaDescriptor = {
      properties: { custom: { type: "string" } },
      required: ["custom"],
      type: "object"
    };
    const tool = {
      getInputSchemaDescriptor: () => override,
      inputSchema: z.object({ ignored: z.string() })
    };

    expect(getToolInputSchemaDescriptor(tool)).toBe(override);
  });

  it("derives file tool descriptors without stack overflow", () => {
    const sandbox = new SandboxService({ workspaceRoot: process.cwd() });
    const cases: Array<[string, { inputSchema: z.ZodTypeAny }]> = [
      ["read_file", new ReadFileTool(sandbox)],
      ["write_file", new WriteFileTool(sandbox)],
      ["patch", new PatchTool(sandbox)],
      ["glob", new GlobTool(sandbox)],
      ["search_files", new CodeSearchTool(sandbox)]
    ];
    for (const [name, tool] of cases) {
      expect(() => getToolInputSchemaDescriptor(tool), name).not.toThrow();
    }
  });

  it("exposes code search mode options", () => {
    const sandbox = new SandboxService({ workspaceRoot: process.cwd() });
    const descriptor = getToolInputSchemaDescriptor(new CodeSearchTool(sandbox));

    expect(descriptor.properties?.mode).toEqual({
      enum: ["matches", "files", "count"],
      type: "string"
    });
  });
});
