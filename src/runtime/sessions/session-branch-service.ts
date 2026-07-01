import { randomUUID } from "node:crypto";

import type {
  SessionDraft,
  SessionLineageRepository,
  SessionRecord,
  SessionRepository
} from "../../types/index.js";
import type { SessionUiStateService } from "./session-ui-state-service.js";
import type { TodoSessionStore } from "../../tools/todo-session-store.js";
import type { SessionSummaryService } from "../context/session-summary-service.js";

export interface SessionBranchServiceDependencies {
  sessionLineageRepository: SessionLineageRepository;
  sessionRepository: SessionRepository;
  sessionSummaryService: SessionSummaryService;
  sessionUiStateService: SessionUiStateService;
  todoSessionStore: TodoSessionStore;
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
    const sourceSummary = this.dependencies.sessionSummaryService.findLatestBySession(
      input.sourceSessionId
    );
    if (sourceSummary !== null) {
      this.dependencies.sessionSummaryService.create({
        decisions: sourceSummary.decisions,
        goal: sourceSummary.goal,
        metadata: {
          ...sourceSummary.metadata,
          branchedFromSessionId: input.sourceSessionId,
          branchedFromSummaryId: sourceSummary.sessionSummaryId
        },
        nextActions: sourceSummary.nextActions,
        openLoops: sourceSummary.openLoops,
        runId: null,
        summary: sourceSummary.summary,
        taskId: null,
        sessionId: created.sessionId,
        trigger: "manual"
      });
    }
    const sourceTodos = this.dependencies.todoSessionStore.get(input.sourceSessionId);
    this.dependencies.todoSessionStore.update(created.sessionId, sourceTodos, false);

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
