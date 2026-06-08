import type { ZodTypeAny } from "zod";

import type { JsonObject, ToolSchemaDescriptor } from "../../types/index.js";

interface ZodDefNode {
  type?: string;
  shape?: Record<string, ZodSchemaNode>;
  element?: ZodSchemaNode;
  innerType?: ZodSchemaNode;
  keyType?: ZodSchemaNode;
  valueType?: ZodSchemaNode;
  entries?: Record<string, string>;
  options?: string[];
}

interface ZodSchemaNode {
  _zod?: { def?: ZodDefNode };
  def?: ZodDefNode;
  type?: string;
  minLength?: number | null;
  maxLength?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
  options?: string[];
}

export function getToolInputSchemaDescriptor(tool: {
  getInputSchemaDescriptor?: () => ToolSchemaDescriptor;
  inputSchema: ZodTypeAny;
}): ToolSchemaDescriptor {
  if (tool.getInputSchemaDescriptor !== undefined) {
    return tool.getInputSchemaDescriptor();
  }
  return zodSchemaToDescriptor(tool.inputSchema);
}

export function zodSchemaToDescriptor(schema: ZodTypeAny): ToolSchemaDescriptor {
  const descriptor = convertNode(schema as ZodSchemaNode);
  if (descriptor.type === "object") {
    return descriptor;
  }
  return {
    properties: {
      value: descriptor
    },
    required: ["value"],
    type: "object"
  };
}

function convertNode(node: ZodSchemaNode): ToolSchemaDescriptor {
  const def = node._zod?.def ?? node.def;
  const typeName = def?.type ?? node.type ?? "string";

  switch (typeName) {
    case "object": {
      const shape = def?.shape ?? {};
      const properties: JsonObject = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        const childDef = unwrapNode(child);
        properties[key] = convertNode(childDef);
        if (!isOptionalNode(child)) {
          required.push(key);
        }
      }
      return {
        ...(required.length > 0 ? { required } : {}),
        properties,
        type: "object"
      };
    }
    case "array": {
      const element = def?.element ?? def?.innerType;
      return {
        items: element === undefined ? { type: "string" } : convertNode(unwrapNode(element)),
        type: "array"
      };
    }
    case "string":
      return withStringBounds({ type: "string" }, node);
    case "number":
    case "int":
      return withNumberBounds({ type: "number" }, node);
    case "boolean":
      return { type: "boolean" };
    case "enum":
      return {
        enum: def?.options ?? Object.values(def?.entries ?? {}),
        type: "string"
      };
    case "record":
      return {
        additionalProperties:
          def?.valueType === undefined
            ? true
            : convertNode(unwrapNode(def.valueType)),
        type: "object"
      };
    case "optional":
    case "default":
    case "prefault":
    case "preprocess":
    case "pipe":
    case "transform":
    case "catch":
      return convertNode(unwrapInner(def, node));
    case "nullable":
      return {
        ...convertNode(unwrapInner(def, node)),
        nullable: true
      };
    default:
      return { type: "string" };
  }
}

function unwrapNode(node: ZodSchemaNode): ZodSchemaNode {
  const def = node._zod?.def ?? node.def;
  const typeName = def?.type ?? node.type;
  if (
    typeName === "optional" ||
    typeName === "default" ||
    typeName === "prefault" ||
    typeName === "preprocess" ||
    typeName === "pipe" ||
    typeName === "transform" ||
    typeName === "catch" ||
    typeName === "nullable"
  ) {
    return unwrapInner(def, node);
  }
  return node;
}

function unwrapInner(def: ZodDefNode | undefined, node: ZodSchemaNode): ZodSchemaNode {
  const inner = def?.innerType;
  if (inner !== undefined) {
    return unwrapNode(inner);
  }
  return node;
}

function isOptionalNode(node: ZodSchemaNode): boolean {
  const def = node._zod?.def ?? node.def;
  const typeName = def?.type ?? node.type;
  return (
    typeName === "optional" ||
    typeName === "default" ||
    typeName === "prefault" ||
    typeName === "nullable"
  );
}

function withStringBounds(descriptor: ToolSchemaDescriptor, node: ZodSchemaNode): ToolSchemaDescriptor {
  if (typeof node.minLength === "number" && node.minLength > 0) {
    descriptor.minLength = node.minLength;
  }
  if (typeof node.maxLength === "number") {
    descriptor.maxLength = node.maxLength;
  }
  return descriptor;
}

function withNumberBounds(descriptor: ToolSchemaDescriptor, node: ZodSchemaNode): ToolSchemaDescriptor {
  if (typeof node.minValue === "number") {
    descriptor.minimum = node.minValue;
  }
  if (typeof node.maxValue === "number") {
    descriptor.maximum = node.maxValue;
  }
  return descriptor;
}
