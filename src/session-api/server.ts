import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

import { requireHttpAuth } from "../core/http-auth.js";
import type { AgentApplicationService } from "../runtime/application-service.js";
import { readSessionModelSelection } from "../runtime/operations/model-selection-service.js";

export interface SessionApiServerOptions {
  cwd?: string;
  host?: string;
  port: number;
  service: AgentApplicationService;
}

export function createSessionApiServer(options: SessionApiServerOptions) {
  const cwd = options.cwd ?? process.cwd();
  return createServer((request, response) => {
    void handleRequest(options.service, cwd, request, response);
  });
}

export async function startSessionApiServer(options: SessionApiServerOptions): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const server = createSessionApiServer(options);
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error !== undefined ? reject(error) : resolve()));
      }),
    url: `http://${host}:${options.port}`
  };
}

async function handleRequest(
  service: AgentApplicationService,
  cwd: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const auth = requireHttpAuth(request, cwd);
    if (!auth.authorized) {
      writeJson(response, 401, { error: "unauthorized", message: auth.message });
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      if (sessionId !== undefined && service.findSession(sessionId) === null) {
        writeJson(response, 404, { error: "session_not_found" });
        return;
      }
      writeJson(response, 200, service.modelSelectionView(sessionId));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions") {
      const ownerUserId = url.searchParams.get("ownerUserId") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      const entries = service.listSessionIndex({
        ...(ownerUserId !== undefined ? { ownerUserId } : {}),
        ...(status === "active" || status === "archived" || status === "deleted"
          ? { status }
          : {})
      });
      writeJson(response, 200, { sessions: entries });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions/search") {
      const query = url.searchParams.get("q") ?? "";
      const hits = service.searchSessionMessages({ query, limit: 20 });
      writeJson(response, 200, { hits, query });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/u);
    if (request.method === "GET" && sessionMatch !== null) {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      const session = service.findSession(sessionId);
      if (session === null) {
        writeJson(response, 404, { error: "session_not_found" });
        return;
      }
      const detail = service.showSession(sessionId);
      writeJson(response, 200, {
        index: service.listSessionIndex().find((entry) => entry.sessionId === sessionId) ?? null,
        session,
        modelSelection: readSessionModelSelection(session.metadata),
        detail
      });
      return;
    }
    const modelMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/model$/u);
    if (request.method === "PATCH" && modelMatch !== null) {
      const sessionId = decodeURIComponent(modelMatch[1] ?? "");
      if (service.findSession(sessionId) === null) {
        writeJson(response, 404, { error: "session_not_found" });
        return;
      }
      const body = await readJsonBody(request);
      if (body === null) {
        writeJson(response, 400, { error: "invalid_json" });
        return;
      }
      const selection = body.selection;
      if (selection === null) {
        const result = await service.clearSessionModelSelection(sessionId);
        writeJson(response, 200, {
          modelSelection: result.view.session.modelSelection,
          session: result.session,
          view: result.view
        });
        return;
      }
      if (typeof selection !== "string" || selection.trim().length === 0) {
        writeJson(response, 400, { error: "selection_required" });
        return;
      }
      const result = await service.setSessionModelSelection({
        selection,
        sessionId
      });
      writeJson(response, 200, {
        modelSelection: result.view.session.modelSelection,
        session: result.session,
        view: result.view
      });
      return;
    }
    const messagesMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/u);
    if (request.method === "GET" && messagesMatch !== null) {
      const sessionId = decodeURIComponent(messagesMatch[1] ?? "");
      const uiState = service.loadSessionUiState(sessionId);
      if (uiState === null) {
        writeJson(response, 404, { error: "session_not_found" });
        return;
      }
      writeJson(response, 200, uiState);
      return;
    }
    const continueMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/continue$/u);
    if (request.method === "POST" && continueMatch !== null) {
      const sessionId = decodeURIComponent(continueMatch[1] ?? "");
      const body = await readJsonBody(request);
      if (body === null) {
        writeJson(response, 400, { error: "invalid_json" });
        return;
      }
      const input = typeof body.input === "string" ? body.input : "";
      if (input.trim().length === 0) {
        writeJson(response, 400, { error: "input_required" });
        return;
      }
      const result = await service.continueSession(sessionId, input);
      writeJson(response, 200, {
        output: result.output,
        status: result.task.status,
        taskId: result.task.taskId
      });
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  } catch (error) {
    writeJson(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (typeof value === "string") {
      chunks.push(Buffer.from(value));
    } else if (Buffer.isBuffer(value)) {
      chunks.push(value);
    } else if (value instanceof Uint8Array) {
      chunks.push(Buffer.from(value));
    }
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

