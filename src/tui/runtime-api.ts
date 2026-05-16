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
  | "continueThread"
  | "createSchedule"
  | "createThread"
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
  | "listThreads"
  | "listInbox"
  | "markNextActionDone"
  | "pauseSchedule"
  | "providerStats"
  | "resolveApproval"
  | "resumeSchedule"
  | "runScheduleNow"
  | "runTask"
  | "rollbackFileArtifact"
  | "showTask"
  | "showThread"
  | "subscribeToTaskTrace"
  | "traceTask"
>;
