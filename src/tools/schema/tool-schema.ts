import type { ZodTypeAny } from "zod";

import type { JsonObject, ToolSchemaDescriptor } from "../../types/index.js";

interface ZodDefNode {
  type?: string;
  shape?: Record<string, ZodSchemaNode>;
  element?: ZodSchemaNode;
  innerType?: ZodSchemaNode;
  in?: ZodSchemaNode;
  out?: ZodSchemaNode;
  keyType?: ZodSchemaNode;
  valueType?: ZodSchemaNode;
  entries?: Record<string, string>;
  /** Enum member names, or union member schemas. */
  options?: unknown[];
  /** Literal member values. */
  values?: unknown[];
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
        enum: asStringList(def?.options) ?? Object.values(def?.entries ?? {}),
        type: "string"
      };
    case "literal":
      return literalDescriptor(def?.values ?? []);
    case "union":
      return unionDescriptor(def?.options ?? []);
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
    case "transform":
    case "catch":
      return convertNode(unwrapInner(def, node));
    case "pipe":
      return convertNode(unwrapPipeOut(def, node));
    case "nullable":
      return {
        ...convertNode(unwrapInner(def, node)),
        nullable: true
      };
    default:
      return { type: "string" };
  }
}

function literalDescriptor(values: unknown[]): ToolSchemaDescriptor {
  const jsonValues = values.filter(
    (value): value is boolean | number | string =>
      typeof value === "boolean" || typeof value === "number" || typeof value === "string"
  );
  const first = jsonValues[0];
  if (first === undefined) {
    return { type: "string" };
  }
  return {
    enum: jsonValues,
    type: typeof first === "string" ? "string" : typeof first
  };
}

/**
 * Discriminated unions reach here too; zod reports both as `union`. Emitting `anyOf`
 * keeps each variant's own `required` list, which a flattened object would lose.
 */
function unionDescriptor(options: unknown[]): ToolSchemaDescriptor {
  const variants = options.map((option) => convertNode(unwrapNode(option as ZodSchemaNode)));
  const first = variants[0];
  if (first === undefined) {
    return { type: "string" };
  }
  if (variants.length === 1) {
    return first;
  }
  return {
    anyOf: variants,
    type: variants.every((variant) => variant.type === "object") ? "object" : first.type
  };
}

function asStringList(values: unknown[] | undefined): string[] | undefined {
  if (values === undefined || !values.every((value) => typeof value === "string")) {
    return undefined;
  }
  return values;
}

function unwrapNode(node: ZodSchemaNode): ZodSchemaNode {
  const def = node._zod?.def ?? node.def;
  const typeName = def?.type ?? node.type;
  if (
    typeName === "optional" ||
    typeName === "default" ||
    typeName === "prefault" ||
    typeName === "preprocess" ||
    typeName === "transform" ||
    typeName === "catch" ||
    typeName === "nullable"
  ) {
    return unwrapInner(def, node);
  }
  if (typeName === "pipe") {
    return unwrapPipeOut(def, node);
  }
  return node;
}

function unwrapInner(def: ZodDefNode | undefined, node: ZodSchemaNode): ZodSchemaNode {
  const inner = def?.innerType ?? def?.out;
  if (inner !== undefined) {
    return unwrapNode(inner);
  }
  return node;
}

function unwrapPipeOut(def: ZodDefNode | undefined, node: ZodSchemaNode): ZodSchemaNode {
  if (def?.out !== undefined) {
    return unwrapNode(def.out);
  }
  return unwrapInner(def, node);
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
  const minLength = finiteNumber(node.minLength);
  if (minLength !== undefined && minLength > 0) {
    descriptor.minLength = minLength;
  }
  const maxLength = finiteNumber(node.maxLength);
  if (maxLength !== undefined) {
    descriptor.maxLength = maxLength;
  }
  return descriptor;
}

// Unbounded zod numbers report ±Infinity, which JSON.stringify turns into null.
function withNumberBounds(descriptor: ToolSchemaDescriptor, node: ZodSchemaNode): ToolSchemaDescriptor {
  const minimum = finiteNumber(node.minValue);
  if (minimum !== undefined) {
    descriptor.minimum = minimum;
  }
  const maximum = finiteNumber(node.maxValue);
  if (maximum !== undefined) {
    descriptor.maximum = maximum;
  }
  return descriptor;
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
