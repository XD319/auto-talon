import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { z } from "zod";

import type {
  AdapterCapabilityName,
  AdapterDescriptor,
  GatewayRuntimeApi,
  GatewayTaskEvent,
  GatewayTaskRequest,
  InboundMessageAdapter,
  JsonObject,
  JsonValue
} from "../types/index.js";
import { requireHttpAuth } from "../core/http-auth.js";
import { AppError } from "../core/app-error.js";

const MAX_REQUEST_BODY_BYTES = 256_000;
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

export interface LocalWebhookAdapterOptions {
  adapterId?: string;
  cwd?: string;
  host?: string;
  port: number;
}

export class LocalWebhookAdapter implements InboundMessageAdapter {
  public readonly descriptor: AdapterDescriptor;

  private server: Server | null = null;
  private runtimeApi: GatewayRuntimeApi | null = null;

  public constructor(private readonly options: LocalWebhookAdapterOptions) {
    this.descriptor = {
      adapterId: this.options.adapterId ?? "local-webhook",
      contractVersion: 1,
      capabilities: {
        approvalInteraction: {
          detail: "Resolve approvals via GET /tasks/:taskId/approvals and POST /approvals/:approvalId/resolve, or SSE approval_required events.",
          supported: true
        },
        attachmentCapability: {
          detail: "Returns attachment references only.",
          supported: false
        },
        fileCapability: {
          detail: "Returns artifact references only.",
          supported: false
        },
        streamingCapability: {
          detail: "Supports SSE event streams.",
          supported: true
        },
        structuredCardCapability: {
          detail: "Falls back to plain JSON responses.",
          supported: false
        },
        textInteraction: {
          detail: "JSON request and response bodies.",
          supported: true
        }
      },
      description: "Minimal local HTTP adapter for webhook / SDK style integration.",
      displayName: "Local Webhook Adapter",
      kind: "webhook",
      lifecycleState: "created"
    };
  }

  public async start(context: { runtimeApi: GatewayRuntimeApi }): Promise<void> {
    this.runtimeApi = context.runtimeApi;
    this.server = createServer((request, response) => {
      void this.handleRequestSafely(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port, this.options.host ?? "127.0.0.1", () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.server === null) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.server = null;
    this.runtimeApi = null;
  }

  private async handleRequestSafely(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      await this.handleRequest(request, response);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof RequestValidationError) {
        this.respondJson(response, error.statusCode, { error: error.code, message: error.message });
        return;
      }
      if (error instanceof AppError && error.code === "session_busy") {
        this.respondJson(response, 409, {
          error: "session_busy",
          message: error.message,
          retryAfterSeconds: 30
        });
        return;
      }
      this.respondJson(response, 500, { error: "internal_error" });
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.runtimeApi === null) {
      this.respondJson(response, 503, {
        error: "adapter_not_ready"
      });
      return;
    }

    const cwd = this.options.cwd ?? process.cwd();
    const auth = requireHttpAuth(request, cwd);
    if (!auth.authorized) {
      this.respondJson(response, 401, { error: "unauthorized", message: auth.message });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "POST" && url.pathname === "/tasks") {
      const payload = parseGatewayTaskRequest(await readJsonBody<unknown>(request));
      const result = await this.runtimeApi.submitTask(this.descriptor, payload);
      this.respondJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/tasks/stream") {
      const payload = parseGatewayTaskRequest(await readJsonBody<unknown>(request));
      const abortController = new AbortController();
      let closed = false;

      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no"
      });

      const keepalive = setInterval(() => {
        writeSseComment(response, "keepalive");
      }, SSE_KEEPALIVE_INTERVAL_MS);

      const closeStream = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(keepalive);
        response.end();
      };

      response.on("close", () => {
        if (!closed) {
          abortController.abort(new DOMException("SSE client disconnected.", "AbortError"));
        }
        closeStream();
      });

      try {
        const result = await this.runtimeApi.submitTask(this.descriptor, payload, {
          onEvent: (event) => {
            writeSseEvent(response, gatewayTaskEventName(event), event);
          },
          signal: abortController.signal
        });
        writeSseEvent(response, "gateway.result", {
          kind: "gateway_result",
          result
        });
        if (result.result.status === "waiting_approval") {
          for (const approval of this.runtimeApi.listTaskPendingApprovals(result.result.taskId)) {
            writeSseEvent(response, "approval_required", {
              approval: {
                approvalId: approval.approvalId,
                toolCallId: approval.toolCallId,
                toolName: approval.toolName
              },
              kind: "approval_required",
              taskId: result.result.taskId
            });
          }
        }
        writeSseEvent(response, "done", {
          kind: "done",
          taskId: result.result.taskId
        });
      } catch (error) {
        writeSseEvent(response, "error", {
          kind: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        closeStream();
      }
      return;
    }

    if (request.method === "GET" && /^\/tasks\/[^/]+$/.test(url.pathname)) {
      const taskId = url.pathname.split("/")[2] ?? "";
      const snapshot = this.runtimeApi.getTaskSnapshot(taskId);
      if (snapshot === null) {
        this.respondJson(response, 404, { error: "task_not_found" });
        return;
      }

      this.respondJson(response, 200, snapshot);
      return;
    }

    if (request.method === "GET" && /^\/tasks\/[^/]+\/approvals$/.test(url.pathname)) {
      const taskId = url.pathname.split("/")[2] ?? "";
      const snapshot = this.runtimeApi.getTaskSnapshot(taskId);
      if (snapshot === null) {
        this.respondJson(response, 404, { error: "task_not_found" });
        return;
      }
      const approvals = this.runtimeApi.listTaskPendingApprovals(taskId);
      this.respondJson(response, 200, { approvals, taskId });
      return;
    }

    if (request.method === "POST" && /^\/approvals\/[^/]+\/resolve$/.test(url.pathname)) {
      const approvalId = url.pathname.split("/")[2] ?? "";
      const body = await readJsonBody<{
        action?: "allow" | "deny";
        allowScope?: "once" | "session" | "always";
        reviewerId?: string;
      }>(request);
      if (body.action !== "allow" && body.action !== "deny") {
        throw new RequestValidationError("invalid_request", "action must be allow or deny.");
      }
      if (typeof body.reviewerId !== "string" || body.reviewerId.length === 0) {
        throw new RequestValidationError("invalid_request", "reviewerId is required.");
      }
      const result = await this.runtimeApi.resolveApproval({
        adapterId: this.descriptor.adapterId,
        ...(body.action === "allow" && body.allowScope !== undefined
          ? { allowScope: body.allowScope }
          : {}),
        approvalId,
        decision: body.action,
        reviewerExternalUserId: null,
        reviewerRuntimeUserId: body.reviewerId
      });
      if (result === null) {
        this.respondJson(response, 404, { error: "approval_not_found" });
        return;
      }
      this.respondJson(response, 200, result);
      return;
    }

    if (request.method === "GET" && /^\/tasks\/[^/]+\/events$/.test(url.pathname)) {
      const taskId = url.pathname.split("/")[2] ?? "";
      const snapshot = this.runtimeApi.getTaskSnapshot(taskId);
      if (snapshot === null) {
        this.respondJson(response, 404, { error: "task_not_found" });
        return;
      }

      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no"
      });

      for (const trace of snapshot.trace) {
        const event = { kind: "trace" as const, taskId, trace };
        writeSseEvent(response, gatewayTaskEventName(event), event);
      }
      for (const audit of snapshot.audit) {
        const event = { kind: "audit" as const, taskId, audit };
        writeSseEvent(response, gatewayTaskEventName(event), event);
      }
      for (const notice of snapshot.notices) {
        const event = { kind: "gateway_notice" as const, taskId, notice };
        writeSseEvent(response, gatewayTaskEventName(event), event);
      }
      for (const output of snapshot.output) {
        const event = { kind: "output" as const, taskId, output };
        writeSseEvent(response, gatewayTaskEventName(event), event);
      }

      if (isTerminalStatus(snapshot.task.status)) {
        writeSseEvent(response, "done", {
          kind: "done",
          taskId
        });
        response.end();
        return;
      }

      let closed = false;
      let unsubscribe = (): void => {};
      const keepalive = setInterval(() => {
        writeSseComment(response, "keepalive");
      }, SSE_KEEPALIVE_INTERVAL_MS);
      const closeStream = (emitDone: boolean): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        if (emitDone) {
          writeSseEvent(response, "done", {
            kind: "done",
            taskId
          });
        }
        response.end();
      };

      unsubscribe = this.runtimeApi.subscribeToTaskEvents(taskId, (event) => {
        writeSseEvent(response, gatewayTaskEventName(event), event);
        if (isTerminalGatewayTaskEvent(event)) {
          closeStream(true);
        }
      });

      request.on("close", () => {
        closeStream(false);
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/inbox") {
      const userId = url.searchParams.get("user_id");
      const filter = {
        ...(userId !== null ? { userId } : {}),
        ...(url.searchParams.get("status") !== null
          ? { status: url.searchParams.get("status") as "pending" | "seen" | "done" | "dismissed" }
          : {}),
        ...(url.searchParams.get("category") !== null
          ? {
              category: url.searchParams.get("category") as
                | "task_completed"
                | "task_failed"
                | "approval_requested"
                | "memory_suggestion"
                | "skill_promotion"
            }
          : {})
      };
      const items = this.runtimeApi.listInbox(filter);
      this.respondJson(response, 200, items);
      return;
    }

    if (request.method === "POST" && /^\/inbox\/[^/]+\/done$/.test(url.pathname)) {
      const inboxId = url.pathname.split("/")[2] ?? "";
      const body = await readJsonBody<{ reviewerRuntimeUserId?: string }>(request);
      const item = this.runtimeApi.markInboxDone(inboxId, body.reviewerRuntimeUserId ?? "gateway-user");
      this.respondJson(response, 200, item);
      return;
    }

    if (request.method === "GET" && url.pathname === "/inbox/events") {
      const userId = url.searchParams.get("user_id");
      const filter = {
        ...(userId !== null ? { userId } : {}),
        status: "pending" as const
      };

      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream"
      });

      const initialItems = this.runtimeApi.listInbox(filter);
      for (const item of initialItems) {
        response.write(`data: ${JSON.stringify({ kind: "created", item })}\n\n`);
      }

      const unsubscribe = this.runtimeApi.subscribeToInbox(filter, (event) => {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      request.on("close", () => {
        unsubscribe();
        response.end();
      });
      return;
    }

    this.respondJson(response, 404, {
      error: "not_found"
    });
  }

  private respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, {
      "Content-Type": "application/json"
    });
    response.end(JSON.stringify(payload, null, 2));
  }
}

function isTerminalStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isTerminalGatewayTaskEvent(event: GatewayTaskEvent): boolean {
  return event.kind === "output" && (event.output.eventType === "result" || event.output.eventType === "error");
}

function gatewayTaskEventName(event: GatewayTaskEvent): string {
  switch (event.kind) {
    case "output":
      return `output.${event.output.eventType}`;
    case "trace":
      return `trace.${event.trace.eventType}`;
    case "audit":
      return `audit.${event.audit.action}`;
    case "gateway_notice":
      return "gateway.notice";
    case "progress":
      return "progress";
  }
}

function writeSseEvent(response: ServerResponse, eventName: string, payload: unknown): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function writeSseComment(response: ServerResponse, comment: string): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.write(`: ${comment}\n\n`);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      throw new RequestValidationError("invalid_request", "Content-Length header is invalid.");
    }
    if (parsedLength > MAX_REQUEST_BODY_BYTES) {
      throw new RequestValidationError(
        "payload_too_large",
        `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`,
        413
      );
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        throw new RequestValidationError(
          "payload_too_large",
          `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`,
          413
        );
      }
      chunks.push(chunk);
      continue;
    }

    if (chunk instanceof Uint8Array) {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        throw new RequestValidationError(
          "payload_too_large",
          `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`,
          413
        );
      }
      chunks.push(Buffer.from(chunk));
      continue;
    }

    const asBuffer = Buffer.from(String(chunk));
    totalBytes += asBuffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestValidationError(
        "payload_too_large",
        `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`,
        413
      );
    }
    chunks.push(asBuffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new RequestValidationError("invalid_json", "Request body must contain valid JSON.");
  }
}

const adapterCapabilityRequirementSchema = z.enum(["preferred", "required"]);
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    jsonObjectSchema
  ])
);
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

const adapterCapabilityNameSchema = z.enum([
  "approvalInteraction",
  "attachmentCapability",
  "fileCapability",
  "streamingCapability",
  "structuredCardCapability",
  "textInteraction"
]);

const gatewayTaskRequestSchema = z.object({
  agentProfileId: z.enum(["executor", "planner", "reviewer"]).optional(),
  continuation: z.enum(["new", "resume-latest"]).optional(),
  cwd: z.string().min(1).optional(),
  interactionRequirements: z
    .partialRecord(adapterCapabilityNameSchema, adapterCapabilityRequirementSchema)
    .optional(),
  metadata: z.record(z.string(), jsonValueSchema).optional(),
  requester: z.object({
    externalSessionId: z.string().min(1),
    externalUserId: z.string().min(1).nullable(),
    externalUserLabel: z.string().min(1).nullable()
  }),
  taskInput: z.string().min(1),
  timeoutMs: z.number().positive().optional()
});

function parseGatewayTaskRequest(input: unknown): GatewayTaskRequest {
  const parsed = gatewayTaskRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RequestValidationError(
      "invalid_request",
      `Invalid gateway task request: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`
    );
  }

  const request: GatewayTaskRequest = {
    requester: parsed.data.requester,
    taskInput: parsed.data.taskInput
  };

  if (parsed.data.agentProfileId !== undefined) {
    request.agentProfileId = parsed.data.agentProfileId;
  }
  if (parsed.data.continuation !== undefined) {
    request.continuation = parsed.data.continuation;
  }
  if (parsed.data.cwd !== undefined) {
    request.cwd = parsed.data.cwd;
  }
  if (parsed.data.interactionRequirements !== undefined) {
    request.interactionRequirements = parsed.data.interactionRequirements as Partial<
      Record<AdapterCapabilityName, "preferred" | "required">
    >;
  }
  if (parsed.data.metadata !== undefined) {
    request.metadata = parsed.data.metadata;
  }
  if (parsed.data.timeoutMs !== undefined) {
    request.timeoutMs = parsed.data.timeoutMs;
  }

  return request;
}

class RequestValidationError extends Error {
  public constructor(
    public readonly code: "invalid_json" | "invalid_request" | "payload_too_large",
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "RequestValidationError";
  }
}
