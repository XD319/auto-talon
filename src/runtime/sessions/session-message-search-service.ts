import type {
  SessionMessageKind,
  SessionMessageRepository,
  SessionMessageSearchHit
} from "../../types/index.js";

export interface SessionMessageSearchServiceDependencies {
  messageRepository: SessionMessageRepository;
}

export interface SessionSearchRequestScope {
  ownerUserId?: string;
  workspaceRoot?: string;
}

export class SessionMessageSearchService {
  public constructor(private readonly dependencies: SessionMessageSearchServiceDependencies) {}

  public search(input: {
    limit?: number;
    query: string;
    sessionIdPrefix?: string;
    ownerUserId?: string;
    workspaceRoot?: string;
    roleFilter?: SessionMessageKind[];
    window?: number;
  }): SessionMessageSearchHit[] {
    return this.dependencies.messageRepository.search({
      limit: input.limit ?? 20,
      query: input.query,
      ...(input.sessionIdPrefix !== undefined ? { sessionIdPrefix: input.sessionIdPrefix } : {}),
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      ...(input.roleFilter !== undefined ? { roleFilter: input.roleFilter } : {}),
      ...(input.window !== undefined ? { window: input.window } : {})
    });
  }

  public scroll(input: {
    sessionId: string;
    aroundMessageId: string;
    window: number;
    ownerUserId?: string;
    workspaceRoot?: string;
  }): SessionMessageSearchHit[] {
    return this.dependencies.messageRepository.scroll?.(input) ?? [];
  }

  public browse(input: {
    limit?: number;
    ownerUserId?: string;
    workspaceRoot?: string;
  }): SessionMessageSearchHit[] {
    return this.dependencies.messageRepository.browse?.({ ...input, limit: input.limit ?? 20 }) ?? [];
  }
}