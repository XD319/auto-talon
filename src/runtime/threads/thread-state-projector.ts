import type { ConversationMessage, ContextFragment, ThreadRunRepository } from "../../types/index.js";

export interface ThreadStateProjection {
  messages: ConversationMessage[];
  memoryContext: ContextFragment[];
}

export interface ThreadStateProjectorDependencies {
  threadRunRepository: ThreadRunRepository;
}

export class ThreadStateProjector {
  public constructor(private readonly dependencies: ThreadStateProjectorDependencies) {}

  public projectState(threadId: string): ThreadStateProjection {
    const runs = this.dependencies.threadRunRepository.listByThreadId(threadId);
    const messages: ConversationMessage[] = runs.map((run) => ({
      role: "system",
      content: `ThreadRun#${run.runNumber} status=${run.status} input=${run.input}\nsummary=${JSON.stringify(run.summary)}`
    }));
    return {
      messages,
      memoryContext: []
    };
  }
}
