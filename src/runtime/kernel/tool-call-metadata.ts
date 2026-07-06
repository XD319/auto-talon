import type { TaskRecord } from "../../types/index.js";

export function buildToolTaskMetadata(task: TaskRecord): TaskRecord["metadata"] {
  return {
    ...task.metadata,
    ...(task.sessionId !== null && task.sessionId !== undefined ? { sessionId: task.sessionId } : {})
  };
}
