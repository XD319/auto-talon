import type {
  AdapterDescriptor,
  GatewayCapabilityNotice,
  GatewayRuntimeApi,
  GatewayTaskEvent,
  GatewayTaskLaunchResult,
  GatewayTaskResultView,
  InboundMessageAdapter,
  OutboundResponseAdapter
} from "../../types/index.js";
import {
  renderApprovalCard,
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

  public async handleCardActionEvent(event: {
    approvalId: string;
    chatId: string;
    decision: "allow" | "deny";
    openId: string | null;
    taskId: string;
  }): Promise<void> {
    if (this.runtimeApi === null) {
      return;
    }
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
    if (result !== null) {
      await this.sendTaskResultToChat(
        event.chatId.length > 0 ? event.chatId : result.sessionBinding.externalSessionId,
        result
      );
    }
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

  private async sendTaskResultToChat(chatId: string, result: GatewayTaskLaunchResult): Promise<void> {
    if (this.client === null) {
      return;
    }
    const sent = await this.createMessageWithRetry(
      createTextMessagePayload(chatId, formatTaskResultText(result.result))
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
    await this.createMessageWithRetry(
      createInteractiveMessagePayload(chatId, renderApprovalCard(result.taskId, result.pendingApprovalId))
    );
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

function createInteractiveMessagePayload(chatId: string, content: string): FeishuCreateMessagePayload {
  return {
    data: {
      content,
      msg_type: "interactive",
      receive_id: chatId
    },
    params: {
      receive_id_type: "chat_id"
    }
  };
}

function createTextMessagePayload(chatId: string, text: string): FeishuCreateMessagePayload {
  return {
    data: {
      content: JSON.stringify({ text: text.slice(0, 4000) }),
      msg_type: "text",
      receive_id: chatId
    },
    params: {
      receive_id_type: "chat_id"
    }
  };
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

function parseCardActionEvent(payload: unknown): {
  approvalId: string;
  chatId: string;
  decision: "allow" | "deny";
  openId: string | null;
  taskId: string;
} {
  const event = getEventBody(payload);
  const context = getRecord(event, "context");
  const openMessageId = readString(context, "open_message_id") ?? readString(event, "open_message_id") ?? "";
  const action = getRecord(event, "action");
  const value = getRecord(action, "value") ?? action ?? getRecord(event, "value");
  const approvalId = readString(value, "approvalId") ?? "";
  const decisionRaw = readString(value, "decision");
  const taskId = readString(value, "taskId") ?? "";
  const operator = getRecord(event, "operator");
  const operatorId = operator === null ? null : getRecord(operator, "operator_id");
  const openId = readString(operatorId, "open_id") ?? readString(event, "open_id");

  return {
    approvalId,
    chatId: readString(context, "open_chat_id") ?? readString(event, "open_chat_id") ?? openMessageId,
    decision: decisionRaw === "deny" ? "deny" : "allow",
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
