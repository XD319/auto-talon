import { z } from "zod";

import type {
  JsonObject,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

import {
  resolveTodoSessionKey,
  MAX_TODO_ITEMS,
  type TodoItem,
  type TodoSessionStore,
  type TodoStatus
} from "./todo-session-store.js";

const todoStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);
const MAX_TODO_CONTENT_LENGTH = 500;
const MAX_TODO_ID_LENGTH = 100;

const todoItemSchema = z.object({
  content: z.string().min(1).max(MAX_TODO_CONTENT_LENGTH),
  id: z.string().min(1).max(MAX_TODO_ID_LENGTH),
  status: todoStatusSchema
});

const todoSchema = z.object({
  merge: z.boolean().default(true),
  todos: z.array(todoItemSchema).max(MAX_TODO_ITEMS)
});

export interface PreparedTodoInput {
  merge: boolean;
  todos: TodoItem[];
}

export class TodoTool implements ToolDefinition<typeof todoSchema, PreparedTodoInput> {
  public readonly name = "todo";
  public readonly description =
    "Create or update the session todo list. Use merge=true to upsert items by id, or merge=false with an empty list to clear it.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "runtime_mutation" as const;
  public readonly toolKind = "control_command" as const;
  public readonly inputSchema = todoSchema;

  public constructor(private readonly store: TodoSessionStore) {}

  public prepare(input: unknown): ToolPreparation<PreparedTodoInput> {
    const parsed = this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "workspace",
        summary: `Update ${parsed.todos.length} todo item(s)`
      },
      preparedInput: parsed,
      sandbox: {
        kind: "prompt",
        pathScope: "workspace",
        target: "interactive_user"
      }
    };
  }

  public execute(
    preparedInput: PreparedTodoInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const sessionKey = resolveTodoSessionKey(context);
    const todos = this.store.update(sessionKey, preparedInput.todos, preparedInput.merge);
    const output: JsonObject = {
      merge: preparedInput.merge,
      sessionKey,
      todos: todos.map((todo) => ({
        content: todo.content,
        id: todo.id,
        status: todo.status,
        ...(todo.statusUpdatedAt !== undefined ? { statusUpdatedAt: todo.statusUpdatedAt } : {})
      }))
    };
    return Promise.resolve({
      output,
      success: true,
      summary: `Updated ${todos.length} todo item(s) for session ${sessionKey}`
    });
  }
}

export { todoStatusSchema, type TodoStatus };
