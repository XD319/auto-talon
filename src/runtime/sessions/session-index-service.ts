import type {
  JsonObject,
  SessionIndexEntry,
  SessionListQuery,
  SessionMessageRepository,
  SessionRecord,
  SessionRepository
} from "../../types/index.js";

export interface SessionIndexServiceDependencies {
  messageRepository: SessionMessageRepository;
  sessionRepository: SessionRepository;
}

export class SessionIndexService {
  public constructor(private readonly dependencies: SessionIndexServiceDependencies) {}

  public list(query: SessionListQuery = {}): SessionIndexEntry[] {
    const sessions = this.dependencies.sessionRepository.list(query);
    return sessions.map((session) => this.toIndexEntry(session));
  }

  public latestForUser(ownerUserId: string): SessionIndexEntry | null {
    const sessions = this.dependencies.sessionRepository.list({
      ownerUserId,
      status: "active"
    });
    const latest = sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return latest === undefined ? null : this.toIndexEntry(latest);
  }

  public find(sessionId: string): SessionIndexEntry | null {
    const session = this.dependencies.sessionRepository.findById(sessionId);
    return session === null ? null : this.toIndexEntry(session);
  }

  private toIndexEntry(session: SessionRecord): SessionIndexEntry {
    const metadata = session.metadata;
    return {
      messageCount: this.dependencies.messageRepository.countBySessionId(session.sessionId),
      preview: this.dependencies.messageRepository.findLatestUserPreview(session.sessionId),
      sessionId: session.sessionId,
      source: readMetadataString(metadata, "source") ?? "unknown",
      sourceDetail: readMetadataString(metadata, "sourceDetail"),
      title: session.title.length > 0 ? session.title : "Untitled session",
      updatedAt: session.updatedAt
    };
  }
}

function readMetadataString(metadata: JsonObject, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
