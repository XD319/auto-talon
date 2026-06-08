import type { SessionMessageRepository, SessionMessageSearchHit } from "../../types/index.js";

export interface SessionMessageSearchServiceDependencies {
  messageRepository: SessionMessageRepository;
}

export class SessionMessageSearchService {
  public constructor(private readonly dependencies: SessionMessageSearchServiceDependencies) {}

  public search(input: {
    limit?: number;
    query: string;
    sessionIdPrefix?: string;
  }): SessionMessageSearchHit[] {
    return this.dependencies.messageRepository.search({
      limit: input.limit ?? 20,
      query: input.query,
      ...(input.sessionIdPrefix !== undefined ? { sessionIdPrefix: input.sessionIdPrefix } : {})
    });
  }
}
