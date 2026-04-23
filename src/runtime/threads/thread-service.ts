import { randomUUID } from "node:crypto";

import type {
  ThreadDraft,
  ThreadLineageRepository,
  ThreadRecord,
  ThreadRepository,
  ThreadRunRecord,
  ThreadRunRepository,
  ThreadStatus
} from "../../types/index.js";

export interface ThreadListQuery {
  ownerUserId?: string;
  status?: ThreadStatus;
}

export interface ThreadDetail {
  thread: ThreadRecord | null;
  runs: ThreadRunRecord[];
}

export interface ThreadServiceDependencies {
  threadRepository: ThreadRepository;
  threadRunRepository: ThreadRunRepository;
  threadLineageRepository: ThreadLineageRepository;
}

export class ThreadService {
  public constructor(private readonly dependencies: ThreadServiceDependencies) {}

  public createThread(draft: ThreadDraft): ThreadRecord {
    return this.dependencies.threadRepository.create(draft);
  }

  public getOrCreateThread(options: {
    threadId?: string;
    title: string;
    cwd: string;
    ownerUserId: string;
    agentProfileId: ThreadRecord["agentProfileId"];
    providerName: string;
  }): ThreadRecord {
    if (options.threadId !== undefined) {
      const existing = this.dependencies.threadRepository.findById(options.threadId);
      if (existing === null) {
        throw new Error(`Thread ${options.threadId} was not found.`);
      }
      return existing;
    }
    return this.createThread({
      threadId: randomUUID(),
      title: options.title,
      cwd: options.cwd,
      ownerUserId: options.ownerUserId,
      agentProfileId: options.agentProfileId,
      providerName: options.providerName
    });
  }

  public archiveThread(threadId: string): ThreadRecord {
    const archivedAt = new Date().toISOString();
    const updated = this.dependencies.threadRepository.update(threadId, {
      archivedAt,
      status: "archived"
    });
    this.dependencies.threadLineageRepository.append({
      lineageId: randomUUID(),
      threadId,
      eventType: "archive",
      payload: { archivedAt }
    });
    return updated;
  }

  public listThreads(query?: ThreadListQuery): ThreadRecord[] {
    return this.dependencies.threadRepository.list(query);
  }

  public showThread(threadId: string): ThreadDetail {
    const thread = this.dependencies.threadRepository.findById(threadId);
    if (thread === null) {
      return { thread: null, runs: [] };
    }
    return {
      thread,
      runs: this.dependencies.threadRunRepository.listByThreadId(threadId)
    };
  }

  public findLatestThread(ownerUserId: string): ThreadRecord | null {
    return this.dependencies.threadRepository.findLatestByOwner(ownerUserId);
  }
}
