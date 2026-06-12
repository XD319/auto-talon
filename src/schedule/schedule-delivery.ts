import { SCHEDULE_DELIVERY_TARGETS } from "../types/index.js";
import type { JsonObject, ScheduleDeliveryTarget, ScheduleRecord } from "../types/index.js";

export function readScheduleDeliveryTargets(schedule: ScheduleRecord | null): ScheduleDeliveryTarget[] {
  if (schedule === null) {
    return ["inbox"];
  }
  const delivery = readJsonObject(schedule.metadata.delivery);
  const targets = delivery?.targets;
  if (!Array.isArray(targets)) {
    return readJsonObject(schedule.metadata.origin) !== null ? ["inbox", "origin"] : ["inbox"];
  }
  return targets.filter(isScheduleDeliveryTarget);
}

export function resolveDefaultDeliveryTargets(metadata: JsonObject): ScheduleDeliveryTarget[] {
  const targets: ScheduleDeliveryTarget[] = ["inbox"];
  if (readJsonObject(metadata.origin) !== null) {
    targets.push("origin");
  }
  return targets;
}

export function shouldDeliverToInbox(schedule: ScheduleRecord | null): boolean {
  return readScheduleDeliveryTargets(schedule).includes("inbox");
}

export function shouldDeliverToOrigin(schedule: ScheduleRecord | null): boolean {
  if (schedule === null) {
    return false;
  }
  const delivery = readJsonObject(schedule.metadata.delivery);
  const targets = delivery?.targets;
  if (!Array.isArray(targets)) {
    return readJsonObject(schedule.metadata.origin) !== null;
  }
  return targets.includes("origin");
}

export function shouldSuppressOriginCompletion(schedule: ScheduleRecord | null): boolean {
  return readScheduleDeliveryTargets(schedule).includes("silent");
}

export function shouldDeliverViaWebhook(schedule: ScheduleRecord | null): boolean {
  return readScheduleDeliveryTargets(schedule).includes("webhook");
}

export function readScheduleWebhookUrl(schedule: ScheduleRecord | null): string | null {
  if (!shouldDeliverViaWebhook(schedule)) {
    return null;
  }
  const delivery = readJsonObject(schedule?.metadata.delivery ?? null);
  const webhookUrl = delivery?.webhookUrl;
  return typeof webhookUrl === "string" && webhookUrl.length > 0 ? webhookUrl : null;
}

function isScheduleDeliveryTarget(value: unknown): value is ScheduleDeliveryTarget {
  return typeof value === "string" && SCHEDULE_DELIVERY_TARGETS.includes(value as ScheduleDeliveryTarget);
}

function readJsonObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}
