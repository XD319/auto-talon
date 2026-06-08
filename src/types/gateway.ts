import type { JsonObject } from "./common.js";

export interface GatewaySessionBindingDraft {
  adapterId: string;
  externalSessionId: string;
  externalUserId: string | null;
  metadata: JsonObject;
  runtimeSessionId?: string | null;
  runtimeUserId: string;
  sessionBindingId: string;
  taskId: string;
}
