import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import {
  formatTodoPanelLine,
  formatTodoPanelTitle,
  selectVisibleTodos,
  toTodoTracePayload
} from "../view-models/todo-format.js";
import type { TodoItem } from "../../tools/todo-session-store.js";

export interface TodoPanelProps {
  open: boolean;
  todos: TodoItem[];
}

function TodoPanelBase({ open, todos }: TodoPanelProps): React.ReactElement | null {
  if (todos.length === 0) {
    return null;
  }

  const snapshot = toTodoTracePayload(todos);
  const { overflowSummary, visible } = selectVisibleTodos(snapshot.todos);

  if (!open) {
    return (
      <Box borderStyle="classic" borderColor={theme.border} flexDirection="column" paddingX={1}>
        <Text color={theme.muted}>{formatTodoPanelTitle(snapshot, false)}</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="classic" borderColor={theme.border} flexDirection="column" paddingX={1}>
      <Text color={theme.panelTitle}>{formatTodoPanelTitle(snapshot, true)}</Text>
      {visible.map((todo) => (
        <Text key={todo.id} color={theme.fg} wrap="truncate-end">
          {formatTodoPanelLine(todo)}
        </Text>
      ))}
      {overflowSummary !== null ? <Text color={theme.muted}>{overflowSummary}</Text> : null}
    </Box>
  );
}

export const TodoPanel = React.memo(TodoPanelBase);
