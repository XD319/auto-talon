import type {
  ConversationMessage,
  JsonObject,
  SessionMessageRecord,
  SessionMessageRepository,
  SessionTranscriptEventRecord,
  SessionTranscriptRepository
} from "../../types/index.js";

export function buildHygieneConversationMessages(input: {
  sessionId: string;
  sessionMessageRepository: SessionMessageRepository;
  sessionTranscriptRepository: SessionTranscriptRepository;
}): ConversationMessage[] {
  const transcriptMessages = transcriptEventsToConversationMessages(
    input.sessionTranscriptRepository.listBySessionId(input.sessionId)
  );
  if (transcriptMessages.length > 0) {
    return transcriptMessages;
  }

  return input.sessionMessageRepository
    .listBySessionId(input.sessionId)
    .map(sessionMessageToConversationMessage)
    .filter((message): message is ConversationMessage => message !== null);
}

function transcriptEventsToConversationMessages(
  events: SessionTranscriptEventRecord[]
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const event of events) {
    switch (event.eventType) {
      case "user_message":
        if (typeof event.content === "string" && event.content.trim().length > 0) {
          messages.push({ content: event.content, role: "user" });
        }
        break;
      case "assistant_message":
        if (typeof event.content === "string" && event.content.trim().length > 0) {
          messages.push({ content: event.content, role: "assistant" });
        }
        break;
      case "tool_call": {
        const toolCalls = readTranscriptToolCalls(event.payload);
        if (toolCalls.length > 0) {
          messages.push({
            content: event.content ?? "",
            role: "assistant",
            toolCalls
          });
        }
        break;
      }
      case "tool_result": {
        const toolCallId = readString(event.payload.toolCallId);
        const toolName = readString(event.payload.toolName);
        if (toolCallId !== null && toolName !== null && typeof event.content === "string") {
          messages.push({
            content: event.content,
            role: "tool",
            toolCallId,
            toolName
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return messages;
}

function readTranscriptToolCalls(
  payload: SessionTranscriptEventRecord["payload"]
): NonNullable<ConversationMessage["toolCalls"]> {
  const rawCalls = payload.toolCalls;
  if (!Array.isArray(rawCalls)) {
    return [];
  }
  const toolCalls: NonNullable<ConversationMessage["toolCalls"]> = [];
  for (const rawCall of rawCalls) {
    if (typeof rawCall !== "object" || rawCall === null) {
      continue;
    }
    const call = rawCall as Record<string, unknown>;
    const toolCallId = readString(call.toolCallId);
    const toolName = readString(call.toolName);
    if (toolCallId === null || toolName === null) {
      continue;
    }
    toolCalls.push({
      input:
        typeof call.input === "object" && call.input !== null
          ? (call.input as JsonObject)
          : {},
      reason: readString(call.reason) ?? "",
      toolCallId,
      toolName
    });
  }
  return toolCalls;
}

function sessionMessageToConversationMessage(
  record: SessionMessageRecord
): ConversationMessage | null {
  const text = typeof record.payload.text === "string" ? record.payload.text.trim() : "";
  if (text.length === 0) {
    return null;
  }
  if (record.kind === "agent") {
    return { content: text, role: "assistant" };
  }
  if (record.kind === "user") {
    return { content: text, role: "user" };
  }
  return { content: text, role: "system" };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
