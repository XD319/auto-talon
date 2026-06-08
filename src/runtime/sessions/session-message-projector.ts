import type {
  SessionEntrySource,
  SessionMessageRepository,
  SessionRepository
} from "../../types/index.js";

export class SessionMessageProjector {
  public constructor(
    private readonly messageRepository: SessionMessageRepository,
    private readonly sessionRepository: SessionRepository
  ) {}

  public projectTaskExchange(input: {
    assistantText: string;
    entrySource?: SessionEntrySource;
    sessionId: string;
    taskId: string;
    userText: string;
  }): void {
    if (this.sessionRepository.findById(input.sessionId) === null) {
      return;
    }
    const entrySource = input.entrySource ?? "cli";
    const now = new Date().toISOString();
    this.messageRepository.append({
      createdAt: now,
      entrySource,
      kind: "user",
      messageId: `user:${input.taskId}`,
      payload: {
        id: `user:${input.taskId}`,
        kind: "user",
        text: input.userText,
        timestamp: now
      },
      sessionId: input.sessionId
    });
    const assistantText = input.assistantText.trim();
    if (assistantText.length === 0) {
      return;
    }
    this.messageRepository.append({
      createdAt: now,
      entrySource,
      kind: "agent",
      messageId: `agent:${input.taskId}`,
      payload: {
        id: `agent:${input.taskId}`,
        kind: "agent",
        text: assistantText,
        timestamp: now
      },
      sessionId: input.sessionId
    });
  }
}
