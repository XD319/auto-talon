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
  | "ensureRuntimeSession"
  | "createSchedule"
  | "createSession"
  | "explainMemoryRecall"
  | "forgetMemory"
  | "listCommitments"
  | "listExperiences"
  | "listMemories"
  | "listMemorySuggestions"
  | "listNextActions"
  | "listPendingApprovals"
  | "listPendingClarifyPrompts"
  | "listScheduleRuns"
  | "listSchedules"
  | "listSkills"
  | "listTasks"
  | "listSessions"
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
  | "traceTask"
>;
