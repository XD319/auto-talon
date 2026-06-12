import type {
  JsonObject,
  ScheduleDeliveryTarget,
  ScheduleRecord,
  ToolsetName
} from "../types/index.js";

import type { ScheduleExecutionMode } from "./execution-mode.js";
import type { ScheduleNoAgentConfig } from "./schedule-metadata.js";

export interface CreateScheduleInput {
  name: string;
  ownerUserId: string;
  cwd: string;
  agentProfileId: ScheduleRecord["agentProfileId"];
  providerName: string;
  input: string;
  sessionId?: string | null;
  runAt?: string | null;
  every?: string | null;
  cron?: string | null;
  timezone?: string | null;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  metadata?: JsonObject;
  deliveryTargets?: ScheduleDeliveryTarget[];
  executionMode?: ScheduleExecutionMode;
  allowDelegate?: boolean;
  noAgent?: ScheduleNoAgentConfig | null;
  repeatRemaining?: number | null;
  skills?: string[];
  toolsets?: ToolsetName[];
}

export interface UpdateScheduleInput {
  agentProfileId?: ScheduleRecord["agentProfileId"];
  allowDelegate?: boolean;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  cron?: string | null;
  deliveryTargets?: ScheduleDeliveryTarget[];
  every?: string | null;
  executionMode?: ScheduleExecutionMode;
  input?: string;
  maxAttempts?: number;
  metadata?: JsonObject;
  name?: string;
  noAgent?: ScheduleNoAgentConfig | null;
  repeatRemaining?: number | null;
  runAt?: string | null;
  sessionId?: string | null;
  skills?: string[];
  timezone?: string | null;
  toolsets?: ToolsetName[];
}
