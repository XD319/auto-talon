import { randomUUID } from "node:crypto";

import type {
  SessionDraft,
  SessionLineageRepository,
  SessionRecord,
  SessionRepository,
  SessionTaskRecord,
  SessionTaskRepository,
  SessionStatus
} from "../../types/index.js";

export interface SessionListQuery {
  ownerUserId?: string;
  status?: SessionStatus;
}

export interface SessionDetail {
  session: SessionRecord | null;
  tasks: SessionTaskRecord[];
}

export interface SessionServiceDependencies {
  sessionRepository: SessionRepository;
  sessionTaskRepository: SessionTaskRepository;
  sessionLineageRepository: SessionLineageRepository;
}

export class SessionService {
  public constructor(private readonly dependencies: SessionServiceDependencies) {}

  public createSession(draft: SessionDraft): SessionRecord {
    return this.dependencies.sessionRepository.create(draft);
  }

  public getOrCreateSession(options: {
    sessionId?: string;
    title: string;
    cwd: string;
    ownerUserId: string;
    agentProfileId: SessionRecord["agentProfileId"];
    providerName: string;
  }): SessionRecord {
    if (options.sessionId !== undefined) {
      return this.dependencies.sessionRepository.getOrCreate({
        sessionId: options.sessionId,
        title: options.title,
        cwd: options.cwd,
        ownerUserId: options.ownerUserId,
        agentProfileId: options.agentProfileId,
        providerName: options.providerName
      });
    }
    return this.createSession({
      sessionId: randomUUID(),
      title: options.title,
      cwd: options.cwd,
      ownerUserId: options.ownerUserId,
      agentProfileId: options.agentProfileId,
      providerName: options.providerName
    });
  }

  public archiveSession(sessionId: string): SessionRecord {
    const archivedAt = new Date().toISOString();
    const updated = this.dependencies.sessionRepository.update(sessionId, {
      archivedAt,
      status: "archived"
    });
    this.dependencies.sessionLineageRepository.append({
      lineageId: randomUUID(),
      sessionId,
      eventType: "archive",
      payload: { archivedAt }
    });
    return updated;
  }

  public listSessions(query?: SessionListQuery): SessionRecord[] {
    return this.dependencies.sessionRepository.list(query);
  }

  public showSession(sessionId: string): SessionDetail {
    const session = this.dependencies.sessionRepository.findById(sessionId);
    if (session === null) {
      return { session: null, tasks: [] };
    }
    return {
      session,
      tasks: this.dependencies.sessionTaskRepository.listBySessionId(sessionId)
    };
  }

  public findLatestSession(ownerUserId: string): SessionRecord | null {
    return this.dependencies.sessionRepository.findLatestByOwner(ownerUserId);
  }
}
