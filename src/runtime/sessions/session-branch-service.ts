import { randomUUID } from "node:crypto";

import type {
  SessionDraft,
  SessionLineageRepository,
  SessionRecord,
  SessionRepository
} from "../../types/index.js";
import type { SessionUiStateService } from "./session-ui-state-service.js";

export interface SessionBranchServiceDependencies {
  sessionLineageRepository: SessionLineageRepository;
  sessionRepository: SessionRepository;
  sessionUiStateService: SessionUiStateService;
}

export interface BranchSessionInput {
  agentProfileId: SessionRecord["agentProfileId"];
  cwd: string;
  ownerUserId: string;
  providerName: string;
  sourceSessionId: string;
  title?: string;
}

export class SessionBranchService {
  public constructor(private readonly dependencies: SessionBranchServiceDependencies) {}

  public branch(input: BranchSessionInput): SessionRecord {
    const source = this.dependencies.sessionRepository.findById(input.sourceSessionId);
    if (source === null) {
      throw new Error(`Session ${input.sourceSessionId} was not found.`);
    }
    const uiState = this.dependencies.sessionUiStateService.load(input.sourceSessionId);
    const branchTitle =
      input.title?.trim().length ? input.title.trim() : `${source.title.length > 0 ? source.title : "Untitled session"} (branch)`;
    const draft: SessionDraft = {
      agentProfileId: input.agentProfileId,
      cwd: input.cwd,
      metadata: {
        ...source.metadata,
        branchedFromSessionId: input.sourceSessionId,
        source: "tui"
      },
      ownerUserId: input.ownerUserId,
      providerName: input.providerName,
      sessionId: randomUUID(),
      title: branchTitle
    };
    const created = this.dependencies.sessionRepository.create(draft);
    if (uiState !== null) {
      this.dependencies.sessionUiStateService.save(created.sessionId, {
        entrySource: "tui",
        interactionMode: uiState.interactionMode,
        messages: uiState.messages,
        sessionApprovalFingerprints: uiState.sessionApprovalFingerprints,
        title: branchTitle
      });
    }
    this.dependencies.sessionLineageRepository.append({
      lineageId: randomUUID(),
      sessionId: created.sessionId,
      eventType: "branch",
      payload: {
        branchTitle,
        sourceSessionId: input.sourceSessionId
      }
    });
    return created;
  }
}
