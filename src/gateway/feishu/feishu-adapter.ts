import { randomUUID } from "node:crypto";

import type {
  AdapterDescriptor,
  GatewayCapabilityNotice,
  GatewayRuntimeApi,
  GatewayTaskEvent,
  GatewayTaskLaunchResult,
  GatewayTaskResultView,
  InboxDeliveryEvent,
  JsonObject,
  InboundMessageAdapter,
  OutboundResponseAdapter,
  ScheduleRecord,
  ScheduleRunRecord
} from "../../types/index.js";
import {
  parseNaturalLanguageScheduleIntent,
  parseNaturalLanguageScheduleWhen,
  type ParsedNaturalLanguageSchedule
} from "../../runtime/scheduler/natural-language-schedule.js";
import {
  renderApprovalCard,
  renderApprovalFailedCard,
  renderApprovalProcessingCard,
  renderApprovalResolvedCard,
  renderScheduleCancelledCard,
  renderScheduleConfirmationCard,
  renderScheduleConfirmationProcessingCard,
  renderScheduleCreatedCard,
  renderScheduleFailedCard,
  renderTaskProgressCard,
  renderTaskResultCard
} from "./feishu-card.js";
import type { FeishuGatewayConfig } from "./feishu-config.js";

interface FeishuClientLike {
  im: {
    message: {
      create: (payload: FeishuCreateMessagePayload) => Promise<{ data?: { message_id?: string } }>;
      patch: (payload: FeishuPatchMessagePayload) => Promise<unknown>;
    };
  };
}

type FeishuCreateMessagePayload = FeishuCreateInteractiveMessagePayload | FeishuCreateTextMessagePayload;

interface FeishuCreateInteractiveMessagePayload {
  data: {
    content: string;
    msg_type: "interactive";
    receive_id: string;
    uuid: string;
  };
  params: {
    receive_id_type: "chat_id";
  };
}

interface FeishuCreateTextMessagePayload {
  data: {
    content: string;
    msg_type: "text";
    receive_id: string;
    uuid: string;
  };
  params: {
    receive_id_type: "chat_id";
  };
}

interface FeishuPatchMessagePayload {
  data: {
    content: string;
  };
  path: {
    message_id: string;
  };
}

interface FeishuWsClientLike {
  start: (options: Record<string, unknown>) => Promise<void> | void;
  stop?: () => void;
}

function isFeishuDebugEnabled(): boolean {
  const nextFlag = process.env.AGENT_FEISHU_DEBUG;
  if (nextFlag !== undefined) {
    return nextFlag === "1" || nextFlag.toLowerCase() === "true";
  }
  const legacyFlag = process.env.AUTO_TALON_FEISHU_DEBUG;
  return legacyFlag === "1" || legacyFlag?.toLowerCase() === "true";
}

interface FeishuEventDispatcherLike {
  register: (handlers: Record<string, (data: unknown) => Promise<void> | void>) => unknown;
}

type FeishuCardActionEvent =
  | {
      actionType: "approval";
      approvalId: string;
      chatId: string;
      decision: "allow" | "deny";
      messageId: string | null;
      openId: string | null;
      taskId: string;
    }
  | {
      actionType: "schedule_confirmation";
      chatId: string;
      confirmationId: string;
      decision: "confirm" | "cancel";
      messageId: string | null;
      openId: string | null;
    };

interface FeishuScheduleDraft {
  chatId: string;
  messageId: string | null;
  openId: string | null;
  prompt: string;
  schedule: ParsedNaturalLanguageSchedule;
  whenText: string;
}

export interface FeishuAdapterOptions {
  adapterId?: string;
  createClients?: (config: FeishuGatewayConfig) => Promise<{
    client: FeishuClientLike;
    createEventDispatcher: () => FeishuEventDispatcherLike;
    wsClient: FeishuWsClientLike;
  }>;
  logger?: {
    debug?: (...message: unknown[]) => void;
    error?: (...message: unknown[]) => void;
    info?: (...message: unknown[]) => void;
    warn?: (...message: unknown[]) => void;
  };
}

export class FeishuAdapter implements InboundMessageAdapter, OutboundResponseAdapter {
  public readonly descriptor: AdapterDescriptor;

  private runtimeApi: GatewayRuntimeApi | null = null;
  private client: FeishuClientLike | null = null;
  private wsClient: FeishuWsClientLike | null = null;
  private readonly handledInboundKeys: string[] = [];
  private readonly handledInboundKeySet = new Set<string>();
  private readonly inFlightInboundKeySet = new Set<string>();
  private readonly handledApprovalActionSet = new Set<string>();
  private readonly inFlightApprovalActionSet = new Set<string>();
  private readonly approvalMessageIds = new Map<string, { chatId: string; messageId: string }>();
  private readonly inFlightApprovalCardIds = new Set<string>();
  private readonly sentApprovalCardIds = new Set<string>();
  private readonly handledScheduleConfirmationIds = new Set<string>();
  private readonly inFlightScheduleConfirmationIds = new Set<string>();
  private readonly scheduleConfirmationDrafts = new Map<string, FeishuScheduleDraft>();
  private readonly scheduleConfirmationMessageIds = new Map<string, { chatId: string; messageId: string }>();
  private readonly taskMessageIds = new Map<string, { chatId: string; messageId: string }>();

  public constructor(
    private readonly config: FeishuGatewayConfig,
    private readonly options: FeishuAdapterOptions = {}
  ) {
    this.descriptor = {
      adapterId: options.adapterId ?? "feishu-im",
      contractVersion: 1,
      capabilities: {
        approvalInteraction: { supported: true },
        attachmentCapability: { supported: true },
        fileCapability: { supported: true },
        streamingCapability: {
          detail: "Feishu v1 sends final task results and approval cards; live token streaming is not wired.",
          supported: false
        },
        structuredCardCapability: { supported: true },
        textInteraction: { supported: true }
      },
      description: "Feishu long-connection adapter for chat ingress and approval callbacks.",
      displayName: "Feishu Adapter",
      kind: "sdk",
      lifecycleState: "created"
    };
  }

  public async start(context: { runtimeApi: GatewayRuntimeApi }): Promise<void> {
    this.runtimeApi = context.runtimeApi;
    const clients =
      this.options.createClients === undefined
        ? await createDefaultClients(this.config, this.options.logger)
        : await this.options.createClients(this.config);
    this.client = clients.client;
    this.wsClient = clients.wsClient;
    const eventDispatcher = clients.createEventDispatcher().register({
      "card.action.trigger": async (payload) => {
        try {
          await this.handleCardActionEvent(parseCardActionEvent(payload));
        } catch (error) {
          this.logError("[feishu-adapter] failed to handle card.action.trigger", error);
        }
      },
      "im.message.receive_v1": async (payload) => {
        try {
          this.logInfo("[feishu-adapter] received im.message.receive_v1", summarizeMessagePayload(payload));
          const event = parseMessageEvent(payload);
          if (event === null) {
            this.logWarn("[feishu-adapter] ignored message event because payload is missing chat/text");
            return;
          }
          const inboundKey = event.messageId ?? event.eventId;
          if (inboundKey !== null && !this.beginInboundMessageHandling(inboundKey)) {
            this.logInfo("[feishu-adapter] ignored duplicate message event", { inboundKey });
            return;
          }
          this.logInfo("[feishu-adapter] submitting message task", {
            chatId: event.chatId,
            eventId: event.eventId,
            hasOpenId: event.openId !== null,
            messageId: event.messageId,
            textLength: event.text.length
          });
          let handledSuccessfully = false;
          try {
            await this.handleMessageEvent(event);
            handledSuccessfully = true;
          } finally {
            this.completeInboundMessageHandling(inboundKey, handledSuccessfully);
          }
        } catch (error) {
          this.logError("[feishu-adapter] failed to handle im.message.receive_v1", error);
        }
      }
    });
    await this.wsClient.start({
      eventDispatcher
    });
  }

  public stop(): Promise<void> {
    this.wsClient?.stop?.();
    this.wsClient = null;
    this.client = null;
    this.runtimeApi = null;
    return Promise.resolve();
  }

  private beginInboundMessageHandling(inboundKey: string): boolean {
    if (this.handledInboundKeySet.has(inboundKey) || this.inFlightInboundKeySet.has(inboundKey)) {
      return false;
    }
    this.inFlightInboundKeySet.add(inboundKey);
    return true;
  }

  private completeInboundMessageHandling(inboundKey: string | null, handledSuccessfully: boolean): void {
    if (inboundKey === null) {
      return;
    }
    this.inFlightInboundKeySet.delete(inboundKey);
    if (!handledSuccessfully) {
      return;
    }
    this.handledInboundKeySet.add(inboundKey);
    this.handledInboundKeys.push(inboundKey);
    while (this.handledInboundKeys.length > 500) {
      const oldest = this.handledInboundKeys.shift();
      if (oldest !== undefined) {
        this.handledInboundKeySet.delete(oldest);
      }
    }
  }

  private beginApprovalActionHandling(approvalId: string): boolean {
    if (this.handledApprovalActionSet.has(approvalId) || this.inFlightApprovalActionSet.has(approvalId)) {
      return false;
    }
    this.inFlightApprovalActionSet.add(approvalId);
    return true;
  }

  private completeApprovalActionHandling(approvalId: string, handledSuccessfully: boolean): void {
    this.inFlightApprovalActionSet.delete(approvalId);
    if (handledSuccessfully) {
      this.handledApprovalActionSet.add(approvalId);
    }
  }

  private beginScheduleConfirmationHandling(confirmationId: string): boolean {
    if (
      this.handledScheduleConfirmationIds.has(confirmationId) ||
      this.inFlightScheduleConfirmationIds.has(confirmationId)
    ) {
      return false;
    }
    this.inFlightScheduleConfirmationIds.add(confirmationId);
    return true;
  }

  private completeScheduleConfirmationHandling(confirmationId: string, handledSuccessfully: boolean): void {
    this.inFlightScheduleConfirmationIds.delete(confirmationId);
    if (handledSuccessfully) {
      this.handledScheduleConfirmationIds.add(confirmationId);
      this.scheduleConfirmationDrafts.delete(confirmationId);
    }
  }

  public async handleMessageEvent(event: {
    chatId: string;
    eventId: string | null;
    messageId: string | null;
    openId: string | null;
    text: string;
  }): Promise<void> {
    if (this.runtimeApi === null || this.client === null) {
      return;
    }
    const trimmed = event.text.trim();
    if (trimmed.length === 0) {
      return;
    }

    if (trimmed.startsWith("/schedule")) {
      await this.handleScheduleCommand(event, trimmed);
      return;
    }

    let scheduleIntent: ReturnType<typeof parseNaturalLanguageScheduleIntent>;
    try {
      scheduleIntent = parseNaturalLanguageScheduleIntent(trimmed);
    } catch (error) {
      await this.sendTextToChat(
        event.chatId,
        error instanceof Error ? error.message : String(error),
        createScheduleCommandUuid(event.messageId, "natural-language-error")
      );
      return;
    }
    if (scheduleIntent !== null) {
      await this.sendScheduleConfirmation(event, {
        prompt: scheduleIntent.taskInput,
        schedule: scheduleIntent.schedule,
        whenText: scheduleIntent.whenText
      });
      return;
    }

    const result = await this.runtimeApi.submitTask(this.descriptor, {
      continuation: trimmed.startsWith("/new ") ? "new" : "resume-latest",
      requester: {
        externalSessionId: event.chatId,
        externalUserId: event.openId,
        externalUserLabel: null
      },
      taskInput: trimmed.replace(/^\/new\s+/, "")
    });

    await this.sendTaskResultToChat(event.chatId, result);
  }

  public async handleCardActionEvent(event: FeishuCardActionEvent): Promise<void> {
    if (this.runtimeApi === null) {
      return;
    }
    if (event.actionType === "schedule_confirmation") {
      await this.handleScheduleConfirmationAction(event);
      return;
    }
    if (!this.beginApprovalActionHandling(event.approvalId)) {
      this.logInfo("[feishu-adapter] ignored duplicate approval action", {
        approvalId: event.approvalId,
        taskId: event.taskId
      });
      return;
    }

    let handledSuccessfully = false;
    try {
      await this.patchApprovalCard(event, renderApprovalProcessingCard(event.taskId, event.approvalId, event.decision));
      const result = await this.runtimeApi.resolveApproval({
        adapterId: this.descriptor.adapterId,
        approvalId: event.approvalId,
        decision: event.decision,
        reviewerExternalUserId: event.openId,
        reviewerRuntimeUserId:
          event.openId === null
            ? `${this.descriptor.adapterId}:session:${event.chatId}`
            : `${this.descriptor.adapterId}:${event.openId}`
      });
      await this.patchApprovalCard(event, renderApprovalResolvedCard(event.taskId, event.approvalId, event.decision));
      if (result !== null) {
        await this.sendTaskResultToChat(
          event.chatId.length > 0 ? event.chatId : result.sessionBinding.externalSessionId,
          result
        );
      }
      handledSuccessfully = true;
    } catch (error) {
      await this.patchApprovalCard(
        event,
        renderApprovalFailedCard(event.taskId, event.approvalId, error instanceof Error ? error.message : String(error))
      );
      throw error;
    } finally {
      this.completeApprovalActionHandling(event.approvalId, handledSuccessfully);
    }
  }

  private async handleScheduleConfirmationAction(
    event: Extract<FeishuCardActionEvent, { actionType: "schedule_confirmation" }>
  ): Promise<void> {
    if (this.runtimeApi === null) {
      return;
    }
    if (!this.beginScheduleConfirmationHandling(event.confirmationId)) {
      this.logInfo("[feishu-adapter] ignored duplicate schedule confirmation action", {
        confirmationId: event.confirmationId
      });
      return;
    }

    let handledSuccessfully = false;
    try {
      const draft = this.scheduleConfirmationDrafts.get(event.confirmationId);
      if (draft === undefined) {
        await this.patchScheduleConfirmationCard(
          event,
          renderScheduleFailedCard(`Schedule confirmation ${event.confirmationId} was not found or already handled.`)
        );
        handledSuccessfully = true;
        return;
      }

      if (event.decision === "cancel") {
        await this.patchScheduleConfirmationCard(event, renderScheduleCancelledCard(draft.whenText, draft.prompt));
        handledSuccessfully = true;
        return;
      }

      await this.patchScheduleConfirmationCard(
        event,
        renderScheduleConfirmationProcessingCard(draft.whenText, draft.prompt)
      );
      const schedule = this.createScheduleFromDraft({
        ...draft,
        openId: event.openId ?? draft.openId
      });
      await this.patchScheduleConfirmationCard(
        event,
        renderScheduleCreatedCard({
          name: schedule.name,
          nextFireAt: schedule.nextFireAt,
          scheduleId: schedule.scheduleId
        })
      );
      handledSuccessfully = true;
    } catch (error) {
      await this.patchScheduleConfirmationCard(
        event,
        renderScheduleFailedCard(error instanceof Error ? error.message : String(error))
      );
      throw error;
    } finally {
      this.completeScheduleConfirmationHandling(event.confirmationId, handledSuccessfully);
    }
  }

  private async handleScheduleCommand(
    event: {
      chatId: string;
      messageId: string | null;
      openId: string | null;
    },
    text: string
  ): Promise<void> {
    if (this.runtimeApi === null) {
      return;
    }
    const command = parseScheduleCommandText(text);
    try {
      switch (command.subcommand) {
        case "list":
          await this.sendTextToChat(
            event.chatId,
            formatScheduleListForFeishu(
              this.listSchedulesForRequester(event, command.args[0] ?? "active"),
              command.args[0] ?? "active"
            ),
            createScheduleCommandUuid(event.messageId, "list")
          );
          return;
        case "create":
          await this.handleScheduleCreateCommand(event, command.rest);
          return;
        case "pause":
        case "resume":
        case "run-now":
        case "runs":
          await this.handleScheduleManagementCommand(event, command.subcommand, command.args);
          return;
        default:
          await this.sendTextToChat(event.chatId, formatScheduleCommandUsage(), createScheduleCommandUuid(event.messageId, "usage"));
          return;
      }
    } catch (error) {
      await this.sendTextToChat(
        event.chatId,
        error instanceof Error ? error.message : String(error),
        createScheduleCommandUuid(event.messageId, "error")
      );
    }
  }

  private async handleScheduleCreateCommand(
    event: {
      chatId: string;
      messageId: string | null;
      openId: string | null;
    },
    payload: string
  ): Promise<void> {
    const separatorIndex = payload.indexOf("|");
    if (separatorIndex <= 0 || separatorIndex === payload.length - 1) {
      await this.sendTextToChat(
        event.chatId,
        "Usage: /schedule create <when> | <prompt>\nExample: /schedule create 1分钟后 | say hello",
        createScheduleCommandUuid(event.messageId, "create-usage")
      );
      return;
    }
    const whenText = payload.slice(0, separatorIndex).trim();
    const prompt = payload.slice(separatorIndex + 1).trim();
    if (whenText.length === 0 || prompt.length === 0) {
      await this.sendTextToChat(
        event.chatId,
        "Usage: /schedule create <when> | <prompt>",
        createScheduleCommandUuid(event.messageId, "create-empty")
      );
      return;
    }
    const schedule = this.createScheduleFromDraft({
      chatId: event.chatId,
      messageId: event.messageId,
      openId: event.openId,
      prompt,
      schedule: parseNaturalLanguageScheduleWhen(whenText),
      whenText
    });
    await this.sendTextToChat(
      event.chatId,
      `Scheduled ${schedule.scheduleId.slice(0, 8)} | ${schedule.name} [${schedule.status}] | next=${schedule.nextFireAt ?? "none"}`,
      createScheduleCommandUuid(event.messageId, "create")
    );
  }

  private async handleScheduleManagementCommand(
    event: {
      chatId: string;
      messageId: string | null;
      openId: string | null;
    },
    subcommand: "pause" | "resume" | "run-now" | "runs",
    args: string[]
  ): Promise<void> {
    if (this.runtimeApi === null) {
      return;
    }
    const prefix = args[0] ?? "";
    if (prefix.length === 0) {
      await this.sendTextToChat(
        event.chatId,
        `Usage: /schedule ${subcommand} <schedule-id-prefix>`,
        createScheduleCommandUuid(event.messageId, `${subcommand}-usage`)
      );
      return;
    }
    const resolved = this.resolveScheduleByPrefix(event, prefix);
    if (resolved.kind !== "one") {
      await this.sendTextToChat(event.chatId, resolved.message, createScheduleCommandUuid(event.messageId, `${subcommand}-resolve`));
      return;
    }

    if (subcommand === "runs") {
      const runs = this.runtimeApi.listScheduleRuns(resolved.item.scheduleId, { tail: 5 });
      await this.sendTextToChat(event.chatId, formatScheduleRunsForFeishu(runs), createScheduleCommandUuid(event.messageId, "runs"));
      return;
    }

    if (subcommand === "run-now") {
      const run = this.runtimeApi.runScheduleNow(resolved.item.scheduleId);
      await this.sendTextToChat(event.chatId, formatScheduleRunsForFeishu([run]), createScheduleCommandUuid(event.messageId, "run-now"));
      return;
    }

    const updated =
      subcommand === "pause"
        ? this.runtimeApi.pauseSchedule(resolved.item.scheduleId)
        : this.runtimeApi.resumeSchedule(resolved.item.scheduleId);
    await this.sendTextToChat(
      event.chatId,
      `Schedule ${subcommand}d: ${updated.scheduleId.slice(0, 8)} | ${updated.name} [${updated.status}] | next=${updated.nextFireAt ?? "none"}`,
      createScheduleCommandUuid(event.messageId, subcommand)
    );
  }

  private async sendScheduleConfirmation(
    event: {
      chatId: string;
      messageId: string | null;
      openId: string | null;
    },
    draft: Pick<FeishuScheduleDraft, "prompt" | "schedule" | "whenText">
  ): Promise<void> {
    if (this.client === null) {
      return;
    }
    const confirmationId = randomUUID();
    this.scheduleConfirmationDrafts.set(confirmationId, {
      chatId: event.chatId,
      messageId: event.messageId,
      openId: event.openId,
      prompt: draft.prompt,
      schedule: draft.schedule,
      whenText: draft.whenText
    });
    const sent = await this.createMessageWithRetry(
      createInteractiveMessagePayload(
        event.chatId,
        renderScheduleConfirmationCard({
          confirmationId,
          prompt: draft.prompt,
          whenText: draft.whenText
        }),
        createScheduleConfirmationUuid(confirmationId)
      )
    );
    const messageId = sent.data?.message_id ?? null;
    if (messageId !== null) {
      this.scheduleConfirmationMessageIds.set(confirmationId, { chatId: event.chatId, messageId });
    }
  }

  private createScheduleFromDraft(draft: FeishuScheduleDraft): ScheduleRecord {
    if (this.runtimeApi === null) {
      throw new Error("Feishu runtime API is not available.");
    }
    return this.runtimeApi.createSchedule(this.descriptor, {
      agentProfileId: "executor",
      input: draft.prompt,
      messageId: draft.messageId,
      metadata: {
        source: "feishu_schedule"
      },
      name: deriveScheduleName(draft.prompt),
      requester: {
        externalSessionId: draft.chatId,
        externalUserId: draft.openId,
        externalUserLabel: null
      },
      ...(draft.schedule.cron !== undefined
        ? { cron: draft.schedule.cron, timezone: resolveLocalTimezone() }
        : {}),
      ...(draft.schedule.every !== undefined ? { every: draft.schedule.every } : {}),
      ...(draft.schedule.runAt !== undefined ? { runAt: draft.schedule.runAt } : {})
    });
  }

  private listSchedulesForRequester(
    event: { chatId: string; openId: string | null },
    filter: string
  ): ScheduleRecord[] {
    if (this.runtimeApi === null) {
      return [];
    }
    if (filter !== "active" && filter !== "paused" && filter !== "completed" && filter !== "archived" && filter !== "all") {
      throw new Error("Usage: /schedule list [active|paused|completed|archived|all]");
    }
    const ownerUserId = resolveFeishuRuntimeUserId(this.descriptor.adapterId, event.chatId, event.openId);
    return this.runtimeApi
      .listSchedules({
        ownerUserId,
        ...(filter === "all" ? {} : { status: filter })
      })
      .sort((left, right) => (left.nextFireAt ?? "9999-12-31T23:59:59.999Z").localeCompare(right.nextFireAt ?? "9999-12-31T23:59:59.999Z"))
      .slice(0, 20);
  }

  private resolveScheduleByPrefix(
    event: { chatId: string; openId: string | null },
    prefix: string
  ): { item: ScheduleRecord; kind: "one" } | { kind: "error"; message: string } {
    const matches = this.listSchedulesForRequester(event, "all").filter((item) => item.scheduleId.startsWith(prefix));
    if (matches.length === 1) {
      return { item: matches[0]!, kind: "one" };
    }
    return {
      kind: "error",
      message:
        matches.length === 0
          ? `No schedule matched prefix '${prefix}'.`
          : `Ambiguous schedule prefix '${prefix}':\n${matches.map((item) => `- ${item.scheduleId.slice(0, 8)} | ${item.name}`).join("\n")}`
    };
  }

  public async sendCapabilityNotice(taskId: string, notice: GatewayCapabilityNotice): Promise<void> {
    const bound = this.taskMessageIds.get(taskId);
    if (bound === undefined || this.client === null) {
      return;
    }
    await this.patchMessageWithRetry({
      data: {
        content: renderTaskProgressCard(taskId, `${notice.capability}: ${notice.message}`)
      },
      path: {
        message_id: bound.messageId
      }
    });
  }

  public async sendEvent(event: GatewayTaskEvent): Promise<void> {
    if (event.kind !== "progress" || this.client === null) {
      return;
    }
    const bound = this.taskMessageIds.get(event.taskId);
    if (bound === undefined) {
      return;
    }
    await this.patchMessageWithRetry({
      data: {
        content: renderTaskProgressCard(event.taskId, event.detail)
      },
      path: {
        message_id: bound.messageId
      }
    });
  }

  public async sendResult(result: GatewayTaskLaunchResult): Promise<void> {
    const bound = this.taskMessageIds.get(result.result.taskId);
    if (bound === undefined || this.client === null) {
      return;
    }
    await this.patchMessageWithRetry({
      data: {
        content: renderTaskResultCard(result.result.output)
      },
      path: {
        message_id: bound.messageId
      }
    });

    if (result.result.status === "waiting_approval") {
      await this.sendApprovalCard(bound.chatId, result.result);
    }
  }

  public async sendInboxEvent(event: InboxDeliveryEvent): Promise<void> {
    if (this.client === null || this.runtimeApi === null || event.kind !== "created") {
      return;
    }
    const origin = readFeishuScheduleOrigin(event.item.metadata);
    if (origin === null || origin.adapter !== this.descriptor.adapterId) {
      return;
    }

    if (event.item.category === "approval_requested") {
      const snapshot = event.item.taskId === null ? null : this.runtimeApi.getTaskSnapshot(event.item.taskId);
      const approvalId =
        event.item.approvalId ??
        readString(event.item.metadata, "approvalId") ??
        snapshot?.task.pendingApprovalId ??
        null;
      if (approvalId === null) {
        await this.sendTextToChat(
          origin.chatId,
          `Approval requested, but no approval id was available.\n${event.item.summary}`,
          createInboxUuid(event.item.inboxId)
        );
        return;
      }
      await this.sendApprovalCard(origin.chatId, {
        errorCode: null,
        errorMessage: null,
        output: null,
        pendingApprovalId: approvalId,
        status: "waiting_approval",
        taskId: event.item.taskId ?? `schedule:${event.item.scheduleRunId ?? event.item.inboxId}`
      });
      return;
    }

    if (event.item.category !== "task_completed" && event.item.category !== "task_failed") {
      return;
    }

    const snapshot = event.item.taskId === null ? null : this.runtimeApi.getTaskSnapshot(event.item.taskId);
    const detail =
      event.item.category === "task_completed"
        ? snapshot?.task.output ?? event.item.summary
        : snapshot?.task.errorMessage ?? event.item.summary;
    const title = event.item.category === "task_completed" ? "Routine completed" : "Routine failed";
    await this.sendTextToChat(
      origin.chatId,
      `${title}: ${event.item.title}\n${detail}`,
      createInboxUuid(event.item.inboxId)
    );
  }

  private async sendTextToChat(chatId: string, text: string, uuid: string): Promise<void> {
    if (this.client === null) {
      return;
    }
    await this.createMessageWithRetry(createTextMessagePayload(chatId, text, uuid));
  }

  private async sendTaskResultToChat(chatId: string, result: GatewayTaskLaunchResult): Promise<void> {
    if (this.client === null) {
      return;
    }
    const sent = await this.createMessageWithRetry(
      createTextMessagePayload(
        chatId,
        formatTaskResultText(result.result),
        createTaskResultUuid(result.result.taskId, result.result.status)
      )
    );
    const messageId = sent.data?.message_id ?? null;
    this.logInfo("[feishu-adapter] sent task result text", {
      messageId,
      taskId: result.result.taskId
    });
    if (result.result.status === "waiting_approval") {
      await this.sendApprovalCard(chatId, result.result);
    }
  }

  private async sendApprovalCard(chatId: string, result: GatewayTaskResultView): Promise<void> {
    if (this.client === null || result.pendingApprovalId === null) {
      return;
    }
    const approvalId = result.pendingApprovalId;
    if (this.sentApprovalCardIds.has(approvalId) || this.inFlightApprovalCardIds.has(approvalId)) {
      return;
    }

    this.inFlightApprovalCardIds.add(approvalId);
    try {
      const sent = await this.createMessageWithRetry(
        createInteractiveMessagePayload(chatId, renderApprovalCard(result.taskId, approvalId), createApprovalCardUuid(approvalId))
      );
      const messageId = sent.data?.message_id ?? null;
      this.sentApprovalCardIds.add(approvalId);
      if (messageId !== null) {
        this.approvalMessageIds.set(approvalId, { chatId, messageId });
      }
    } finally {
      this.inFlightApprovalCardIds.delete(approvalId);
    }
  }

  private async patchApprovalCard(event: { approvalId: string; messageId: string | null }, content: string): Promise<void> {
    if (this.client === null) {
      return;
    }
    const messageId = event.messageId ?? this.approvalMessageIds.get(event.approvalId)?.messageId ?? null;
    if (messageId === null) {
      return;
    }
    try {
      await this.patchMessageWithRetry({
        data: {
          content
      },
      path: {
          message_id: messageId
      }
    });
    } catch (error) {
      this.logWarn("[feishu-adapter] failed to patch approval card", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async patchScheduleConfirmationCard(
    event: { confirmationId: string; messageId: string | null },
    content: string
  ): Promise<void> {
    if (this.client === null) {
      return;
    }
    const messageId = event.messageId ?? this.scheduleConfirmationMessageIds.get(event.confirmationId)?.messageId ?? null;
    if (messageId === null) {
      return;
    }
    try {
      await this.patchMessageWithRetry({
        data: {
          content
        },
        path: {
          message_id: messageId
        }
      });
    } catch (error) {
      this.logWarn("[feishu-adapter] failed to patch schedule confirmation card", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async createMessageWithRetry(
    payload: FeishuCreateMessagePayload
  ): Promise<{ data?: { message_id?: string } }> {
    if (this.client === null) {
      return {};
    }

    return retryFeishuRequest(() => this.client!.im.message.create(payload));
  }

  private async patchMessageWithRetry(payload: FeishuPatchMessagePayload): Promise<unknown> {
    if (this.client === null) {
      return {};
    }

    return retryFeishuRequest(() => this.client!.im.message.patch(payload));
  }

  private logInfo(message: string, data?: unknown): void {
    if (this.options.logger?.info !== undefined) {
      this.options.logger.info(message, data);
      return;
    }
    if (isFeishuDebugEnabled()) {
      console.info(message, data);
    }
  }

  private logWarn(message: string, data?: unknown): void {
    if (this.options.logger?.warn !== undefined) {
      this.options.logger.warn(message, data);
      return;
    }
    console.warn(message, data);
  }

  private logError(message: string, data?: unknown): void {
    const sanitized = sanitizeFeishuLogPayload(data);
    if (this.options.logger?.error !== undefined) {
      this.options.logger.error(message, sanitized);
      return;
    }
    console.error(message, sanitized);
  }
}

function createInteractiveMessagePayload(chatId: string, content: string, uuid: string): FeishuCreateMessagePayload {
  return {
    data: {
      content,
      msg_type: "interactive",
      receive_id: chatId,
      uuid
    },
    params: {
      receive_id_type: "chat_id"
    }
  };
}

function createTextMessagePayload(chatId: string, text: string, uuid: string): FeishuCreateMessagePayload {
  return {
    data: {
      content: JSON.stringify({ text: text.slice(0, 4000) }),
      msg_type: "text",
      receive_id: chatId,
      uuid
    },
    params: {
      receive_id_type: "chat_id"
    }
  };
}

function createTaskResultUuid(taskId: string, status: string): string {
  return `tr-${statusCode(status)}-${taskId}`.slice(0, 50);
}

function createApprovalCardUuid(approvalId: string): string {
  return `ta-${approvalId}`.slice(0, 50);
}

function createScheduleConfirmationUuid(confirmationId: string): string {
  return `tsc-${confirmationId}`.slice(0, 50);
}

function createScheduleCommandUuid(messageId: string | null, action: string): string {
  return `ts-${statusCode(action)}-${messageId ?? randomUUID()}`.slice(0, 50);
}

function createInboxUuid(inboxId: string): string {
  return `ti-${inboxId}`.slice(0, 50);
}

function statusCode(status: string): string {
  switch (status) {
    case "waiting_approval":
      return "wa";
    case "succeeded":
      return "ok";
    case "failed":
      return "fail";
    case "cancelled":
      return "cn";
    case "create":
      return "cr";
    case "list":
      return "ls";
    case "pause":
      return "ps";
    case "resume":
      return "rs";
    case "run-now":
      return "rn";
    case "runs":
      return "rh";
    default:
      return valueToCode(status);
  }
}

function valueToCode(value: string): string {
  return value.replace(/[^a-z0-9]/giu, "").slice(0, 8) || "x";
}

function parseScheduleCommandText(text: string): {
  args: string[];
  rest: string;
  subcommand: string;
} {
  const body = text.replace(/^\/schedule\b/u, "").trim();
  if (body.length === 0) {
    return { args: [], rest: "", subcommand: "list" };
  }
  const firstSpace = body.search(/\s/u);
  const subcommand = firstSpace === -1 ? body : body.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();
  return {
    args: rest.length === 0 ? [] : rest.split(/\s+/u),
    rest,
    subcommand
  };
}

function formatScheduleCommandUsage(): string {
  return [
    "Usage:",
    "/schedule list [active|paused|completed|archived|all]",
    "/schedule create <when> | <prompt>",
    "/schedule pause <schedule-id-prefix>",
    "/schedule resume <schedule-id-prefix>",
    "/schedule run-now <schedule-id-prefix>",
    "/schedule runs <schedule-id-prefix>"
  ].join("\n");
}

function formatScheduleListForFeishu(schedules: ScheduleRecord[], filter: string): string {
  if (schedules.length === 0) {
    return `Schedules (${filter}): none`;
  }
  return `Schedules (${filter}, showing ${schedules.length}):\n${schedules
    .map((item) => `- ${item.scheduleId.slice(0, 8)} | ${item.name} [${item.status}] | next=${item.nextFireAt ?? "none"}`)
    .join("\n")}`;
}

function formatScheduleRunsForFeishu(runs: ScheduleRunRecord[]): string {
  if (runs.length === 0) {
    return "Schedule runs: none";
  }
  return `Schedule runs:\n${runs
    .map((run) => `- ${run.runId.slice(0, 8)} | ${run.status} | attempt=${run.attemptNumber} | task=${run.taskId?.slice(0, 8) ?? "-"}`)
    .join("\n")}`;
}

function deriveScheduleName(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u)[0]?.trim() ?? "";
  const normalized = firstLine.length > 0 ? firstLine : "Scheduled routine";
  return normalized.slice(0, 80);
}

function resolveFeishuRuntimeUserId(adapterId: string, chatId: string, openId: string | null): string {
  return openId === null || openId.trim().length === 0 ? `${adapterId}:session:${chatId}` : `${adapterId}:${openId.trim()}`;
}

function resolveLocalTimezone(): string | null {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof timezone === "string" && timezone.length > 0 ? timezone : null;
  } catch {
    return null;
  }
}

function readFeishuScheduleOrigin(metadata: JsonObject): { adapter: string; chatId: string } | null {
  const origin = readJsonObject(metadata.origin);
  if (origin === null) {
    return null;
  }
  const adapter = readString(origin, "adapter");
  const chatId = readString(origin, "chatId");
  if (adapter === null || chatId === null) {
    return null;
  }
  return { adapter, chatId };
}

function formatTaskResultText(result: GatewayTaskResultView): string {
  if (result.output !== null && result.output.trim().length > 0) {
    return result.output;
  }
  if (result.errorMessage !== null && result.errorMessage.trim().length > 0) {
    return `Execution failed: ${result.errorMessage}`;
  }
  if (result.status === "waiting_approval") {
    return "Approval is required before continuing.";
  }
  return "No output.";
}

async function createDefaultClients(
  config: FeishuGatewayConfig,
  logger?: FeishuAdapterOptions["logger"]
): Promise<{
  client: FeishuClientLike;
  createEventDispatcher: () => FeishuEventDispatcherLike;
  wsClient: FeishuWsClientLike;
}> {
  const packageName = "@larksuiteoapi/node-sdk";
  let lark: LarkSdkModule;
  try {
    lark = (await import(packageName)) as LarkSdkModule;
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(
        "Feishu gateway plugin requires @larksuiteoapi/node-sdk. Install it in this workspace with `pnpm add @larksuiteoapi/node-sdk` or `npm install @larksuiteoapi/node-sdk` before running `talon gateway serve-feishu`."
      );
    }
    throw error;
  }
  const domain = config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const sdkLogger = createFeishuSdkLogger(logger);
  const loggerLevel = isFeishuDebugEnabled() ? lark.LoggerLevel.debug : lark.LoggerLevel.error;
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    logger: sdkLogger,
    loggerLevel
  }) as FeishuClientLike;
  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    logger: sdkLogger,
    loggerLevel
  }) as FeishuWsClientLike;
  const createEventDispatcher = () =>
    new lark.EventDispatcher({ logger: sdkLogger, loggerLevel }) as FeishuEventDispatcherLike;
  return { client, createEventDispatcher, wsClient };
}

interface LarkSdkModule {
  Client: new (options: {
    appId: string;
    appSecret: string;
    domain: unknown;
    logger?: FeishuSdkLogger;
    loggerLevel: unknown;
  }) => unknown;
  Domain: {
    Feishu: unknown;
    Lark: unknown;
  };
  EventDispatcher: new (options: { logger?: FeishuSdkLogger; loggerLevel: unknown }) => unknown;
  LoggerLevel: {
    error: unknown;
    debug: unknown;
  };
  WSClient: new (options: {
    appId: string;
    appSecret: string;
    domain: unknown;
    logger?: FeishuSdkLogger;
    loggerLevel: unknown;
  }) => unknown;
}

interface FeishuSdkLogger {
  debug: (...message: unknown[]) => void;
  error: (...message: unknown[]) => void;
  info: (...message: unknown[]) => void;
  trace: (...message: unknown[]) => void;
  warn: (...message: unknown[]) => void;
}

function isModuleNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("code" in error ? (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND" : true) &&
    error.message.includes("@larksuiteoapi/node-sdk")
  );
}

function parseMessageEvent(payload: unknown): {
  chatId: string;
  eventId: string | null;
  messageId: string | null;
  openId: string | null;
  text: string;
} | null {
  const event = getEventBody(payload);
  if (event === null) {
    return null;
  }
  const message = getRecord(event, "message");
  const sender = getRecord(event, "sender");
  const senderId = sender === null ? null : getRecord(sender, "sender_id");
  const chatId = readString(message, "chat_id");
  const text = readMessageText(message);
  if (chatId === null || text === null) {
    return null;
  }
  return {
    chatId,
    eventId: readString(event, "event_id"),
    messageId: readString(message, "message_id"),
    openId: readString(senderId, "open_id"),
    text
  };
}

function parseCardActionEvent(payload: unknown): FeishuCardActionEvent {
  const event = getEventBody(payload);
  const context = getRecord(event, "context");
  const openMessageId =
    readString(context, "open_message_id") ??
    readString(context, "message_id") ??
    readString(event, "open_message_id") ??
    readString(event, "message_id") ??
    "";
  const action = getRecord(event, "action");
  const value = getRecord(action, "value") ?? action ?? getRecord(event, "value");
  const actionType = readString(value, "actionType");
  const operator = getRecord(event, "operator");
  const operatorId = operator === null ? null : getRecord(operator, "operator_id");
  const openId = readString(operatorId, "open_id") ?? readString(event, "open_id");
  const chatId = readString(context, "open_chat_id") ?? readString(event, "open_chat_id") ?? openMessageId;
  const messageId = openMessageId.length > 0 ? openMessageId : null;

  if (actionType === "schedule_confirmation") {
    const confirmationId = readString(value, "confirmationId") ?? "";
    const decisionRaw = readString(value, "decision");
    return {
      actionType: "schedule_confirmation",
      chatId,
      confirmationId,
      decision: decisionRaw === "cancel" ? "cancel" : "confirm",
      messageId,
      openId
    };
  }

  const approvalId = readString(value, "approvalId") ?? "";
  const decisionRaw = readString(value, "decision");
  const taskId = readString(value, "taskId") ?? "";

  return {
    actionType: "approval",
    approvalId,
    chatId,
    decision: decisionRaw === "deny" ? "deny" : "allow",
    messageId,
    openId,
    taskId
  };
}

function readMessageText(message: Record<string, unknown> | null): string | null {
  if (message === null) {
    return null;
  }
  const content = readString(message, "content");
  if (content === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    const text = readString(getRecord(parsed), "text");
    return text ?? content;
  } catch {
    return content;
  }
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) {
    return null;
  }
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getRecord(input: unknown, key?: string): Record<string, unknown> | null {
  const target = key === undefined ? input : (input as Record<string, unknown> | null)?.[key];
  return typeof target === "object" && target !== null ? (target as Record<string, unknown>) : null;
}

function readJsonObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function getEventBody(payload: unknown): Record<string, unknown> | null {
  const record = getRecord(payload);
  if (record === null) {
    return null;
  }
  return getRecord(record, "event") ?? record;
}

function summarizeMessagePayload(payload: unknown): Record<string, unknown> {
  const record = getRecord(payload);
  const event = getEventBody(payload);
  const message = getRecord(event, "message");
  const sender = getRecord(event, "sender");
  return {
    eventId: readString(event, "event_id"),
    eventKeys: event === null ? [] : Object.keys(event).sort(),
    hasEventEnvelope: record !== null && getRecord(record, "event") !== null,
    messageId: readString(message, "message_id"),
    messageType: readString(message, "message_type"),
    payloadKeys: record === null ? [] : Object.keys(record).sort(),
    senderType: readString(sender, "sender_type")
  };
}

function createFeishuSdkLogger(logger?: FeishuAdapterOptions["logger"]): FeishuSdkLogger {
  return {
    debug: (...message) => {
      logFeishuSdkMessage("debug", logger, message);
    },
    error: (...message) => {
      logFeishuSdkMessage("error", logger, message);
    },
    info: (...message) => {
      logFeishuSdkMessage("info", logger, message);
    },
    trace: (...message) => {
      logFeishuSdkMessage("debug", logger, message);
    },
    warn: (...message) => {
      logFeishuSdkMessage("warn", logger, message);
    }
  };
}

function logFeishuSdkMessage(
  level: "debug" | "error" | "info" | "warn",
  logger: FeishuAdapterOptions["logger"] | undefined,
  message: unknown[]
): void {
  const sanitized = message.map((item) => sanitizeFeishuLogPayload(item));
  const target = logger?.[level];
  if (target !== undefined) {
    target("[feishu-sdk]", ...sanitized);
    return;
  }

  if (level === "debug") {
    console.debug("[feishu-sdk]", ...sanitized);
    return;
  }
  console[level]("[feishu-sdk]", ...sanitized);
}

const FEISHU_RETRY_DELAYS_MS = [200, 500];

async function retryFeishuRequest<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FEISHU_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableFeishuError(error) || attempt === FEISHU_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await delay(FEISHU_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }

  throw lastError;
}

function isRetryableFeishuError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as Error & {
    code?: unknown;
    response?: { status?: unknown };
    status?: unknown;
  };
  const code = typeof candidate.code === "string" ? candidate.code : null;
  const status =
    typeof candidate.response?.status === "number"
      ? candidate.response.status
      : typeof candidate.status === "number"
        ? candidate.status
        : null;

  if (code !== null && RETRYABLE_FEISHU_ERROR_CODES.has(code)) {
    return true;
  }

  return status === 429 || (status !== null && status >= 500);
}

function sanitizeFeishuLogPayload(value: unknown): unknown {
  if (value instanceof Error) {
    const candidate = value as Error & {
      code?: unknown;
      config?: unknown;
      request?: unknown;
      response?: unknown;
      status?: unknown;
    };
    const responseStatus =
      typeof (candidate.response as { status?: unknown } | undefined)?.status === "number"
        ? ((candidate.response as { status?: number }).status ?? null)
        : typeof candidate.status === "number"
          ? candidate.status
          : null;

    return {
      code: typeof candidate.code === "string" ? candidate.code : null,
      message: candidate.message,
      name: candidate.name,
      responseStatus,
      url: sanitizeUrl((candidate.config as { url?: unknown } | undefined)?.url)
    };
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value, redactFeishuSecrets));
  } catch {
    return {
      message: "Unable to serialize feishu error payload safely."
    };
  }
}

function redactFeishuSecrets(key: string, value: unknown): unknown {
  const normalizedKey = key.toLowerCase();
  if (
    normalizedKey === "authorization" ||
    normalizedKey.includes("token") ||
    normalizedKey.includes("secret")
  ) {
    return "[redacted]";
  }

  if (typeof value === "string" && normalizedKey === "_header") {
    return value.replace(/Authorization:\s*Bearer\s+[^\r\n]+/giu, "Authorization: Bearer [redacted]");
  }

  return value;
}

function sanitizeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const RETRYABLE_FEISHU_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNRESET",
  "ETIMEDOUT"
]);
