import type {
  AgentApplicationService,
  AppConfig,
  ResolveAppConfigOptions
} from "../runtime/index.js";
import type { ApprovalActionResult } from "../runtime/application-service.js";

export type TuiAppConfig = AppConfig;
export type TuiResolveAppConfigOptions = ResolveAppConfigOptions;
export type TuiApprovalActionResult = ApprovalActionResult;

export type TuiRuntimeService = Pick<
  AgentApplicationService,
  | "addMemory"
  | "answerClarifyPrompt"
  | "archiveSchedule"
  | "blockCommitment"
  | "blockNextAction"
  | "cancelClarifyPrompt"
  | "completeCommitment"
  | "continueSession"
  | "createSchedule"
  | "createSession"
  | "clearSessionModelSelection"
  | "currentProvider"
  | "ensureRuntimeSession"
  | "explainMemoryRecall"
  | "forgetMemory"
  | "getSessionTodos"
  | "handoffSession"
  | "listCommitments"
  | "listConfiguredProviders"
  | "listExperiences"
  | "listGatewayBindingsForRuntimeSession"
  | "listMemories"
  | "listMemorySuggestions"
  | "modelSelectionView"
  | "listNextActions"
  | "listPendingApprovals"
  | "listPendingClarifyPrompts"
  | "listScheduleRuns"
  | "listSchedules"
  | "listSkills"
  | "listTasks"
  | "listSessions"
  | "listSessionIndex"
  | "loadSessionUiState"
  | "saveSessionUiState"
  | "searchSessionMessages"
  | "latestSessionIndexForUser"
  | "migrateLegacyTranscripts"
  | "branchSession"
  | "findSession"
  | "listInbox"
  | "markNextActionDone"
  | "outputTask"
  | "outputSession"
  | "pauseSchedule"
  | "providerStats"
  | "resolveApproval"
  | "resumeSchedule"
  | "runScheduleNow"
  | "runTask"
  | "rollbackFileArtifact"
  | "showInboxItem"
  | "showTask"
  | "showSession"
  | "subscribeToTaskTrace"
  | "subscribeToTaskOutput"
  | "switchProvider"
  | "traceTask"
  | "updateSessionTitle"
  | "resolveSessionRef"
>;


