import { readScheduleWebhookUrl } from "../scheduler/schedule-delivery.js";
import type { ScheduleRecord } from "../../types/index.js";

export interface ScheduleWebhookPayload {
  category: "task_completed" | "task_failed";
  errorCode: string | null;
  errorMessage: string | null;
  output: string | null;
  runId: string;
  scheduleId: string;
  scheduleName: string;
  status: string;
  taskId: string | null;
}

export interface WebhookDeliveryServiceDependencies {
  fetchImpl?: typeof fetch;
  onFailure?: (input: { errorMessage: string; runId: string; scheduleId: string; webhookUrl: string }) => void;
}

export class WebhookDeliveryService {
  public constructor(private readonly dependencies: WebhookDeliveryServiceDependencies) {}

  public async deliverScheduleOutcome(
    schedule: ScheduleRecord,
    payload: ScheduleWebhookPayload
  ): Promise<void> {
    const webhookUrl = readScheduleWebhookUrl(schedule);
    if (webhookUrl === null) {
      return;
    }
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(webhookUrl, {
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Webhook responded with status ${response.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Schedule webhook delivery failed";
      this.dependencies.onFailure?.({
        errorMessage: message,
        runId: payload.runId,
        scheduleId: payload.scheduleId,
        webhookUrl
      });
    }
  }
}
