import type {
  ConversationMessage,
  ThreadCommitmentState,
  ThreadSessionMemoryRecord
} from "../../types/index.js";
import type { ThreadSessionMemoryService } from "../context/thread-session-memory-service.js";
import type { ThreadCommitmentProjector } from "../commitments/thread-commitment-projector.js";

export interface ThreadStateProjection {
  messages: ConversationMessage[];
  commitmentState: ThreadCommitmentState;
  sessionMemory: ThreadSessionMemoryRecord | null;
}

export interface ThreadStateProjectorDependencies {
  threadSessionMemoryService: ThreadSessionMemoryService;
  commitmentProjector: ThreadCommitmentProjector;
}

export class ThreadStateProjector {
  public constructor(private readonly dependencies: ThreadStateProjectorDependencies) {}

  public projectState(threadId: string): ThreadStateProjection {
    const commitmentState = this.dependencies.commitmentProjector.project(threadId);
    const sessionMemory = this.dependencies.threadSessionMemoryService.findLatestByThread(threadId);
    if (sessionMemory !== null) {
      const messages = toResumeMessages(sessionMemory, commitmentState);
      return {
        commitmentState,
        messages,
        sessionMemory
      };
    }
    return {
      commitmentState,
      messages: [],
      sessionMemory: null
    };
  }
}

function toResumeMessages(
  sessionMemory: ThreadSessionMemoryRecord,
  commitmentState: ThreadCommitmentState
): ConversationMessage[] {
  const messages: ConversationMessage[] = [
    {
      role: "system",
      content: `[Thread Resume] Goal: ${sessionMemory.goal}`
    }
  ];
  if (sessionMemory.decisions.length > 0) {
    messages.push({
      role: "system",
      content: `Decisions: ${sessionMemory.decisions.join(", ")}`
    });
  }
  if (sessionMemory.openLoops.length > 0) {
    messages.push({
      role: "system",
      content: `Open loops: ${sessionMemory.openLoops.join(", ")}`
    });
  }
  if (sessionMemory.nextActions.length > 0) {
    messages.push({
      role: "system",
      content: `Next actions: ${sessionMemory.nextActions.join(", ")}`
    });
  }
  if (commitmentState.currentObjective !== null) {
    messages.push({
      role: "system",
      content: `Current objective: ${commitmentState.currentObjective.title}`
    });
  }
  if (commitmentState.nextAction !== null) {
    messages.push({
      role: "system",
      content: `Next action: ${commitmentState.nextAction.title} (${commitmentState.nextAction.status})`
    });
  }
  if (commitmentState.pendingDecision !== null) {
    messages.push({
      role: "system",
      content: `Pending decision: ${commitmentState.pendingDecision}`
    });
  }
  return messages;
}
