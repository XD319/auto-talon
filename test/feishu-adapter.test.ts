import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuAdapter } from "../src/gateway/index.js";
import type {
  GatewayRuntimeApi,
  InboxItem,
  ScheduleRecord,
  ScheduleRunRecord
} from "../src/types/index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("feishu adapter", () => {
  it("maps message event to runtime submitTask", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "m1" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const start = vi.fn();
    const submitTask = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: true },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: { errorCode: null, errorMessage: null, output: "ok", pendingApprovalId: null, status: "succeeded", taskId: "t1" },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return {
                handlers: registeredHandlers
              };
            }
          }),
          wsClient: { start }
        })
      }
    );
    await adapter.start({
      runtimeApi: {
        getTaskSnapshot: () => null,
        registerOutboundAdapter: () => undefined,
        resolveApproval: vi.fn(() => Promise.resolve(null)),
        submitTask,
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    const payload = {
      event_id: "event-1",
      message: {
        chat_id: "chat",
        content: JSON.stringify({ text: "hello" }),
        message_id: "message-1"
      },
      sender: {
        sender_id: {
          open_id: "open"
        }
      }
    };
    await handlers["im.message.receive_v1"]?.(payload);
    await handlers["im.message.receive_v1"]?.(payload);

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        content: JSON.stringify({ text: "ok" }),
        msg_type: "text",
        receive_id: "chat",
        uuid: "tr-ok-t1"
      },
      params: {
        receive_id_type: "chat_id"
      }
    });
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain("Task Result");
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain("finished with status");
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain("interactive");
    expect(info).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    await adapter.sendEvent({ detail: "halfway", kind: "progress", taskId: "t1" });
    expect(patch).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("keeps compatibility with wrapped event payloads", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "m1" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const submitTask = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: true },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: { errorCode: null, errorMessage: null, output: "ok", pendingApprovalId: null, status: "succeeded", taskId: "t1" },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return {
                handlers: registeredHandlers
              };
            }
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({
      runtimeApi: {
        getTaskSnapshot: () => null,
        registerOutboundAdapter: () => undefined,
        resolveApproval: vi.fn(() => Promise.resolve(null)),
        submitTask,
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    await handlers["im.message.receive_v1"]?.({
      event: {
        event_id: "event-1",
        message: {
          chat_id: "chat",
          content: JSON.stringify({ text: "hello" }),
          message_id: "message-1"
        },
        sender: {
          sender_id: {
            open_id: "open"
          }
        }
      }
    });

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("sends an approval card with the pending approval id", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "m1" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const submitTask = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: false },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: {
        errorCode: null,
        errorMessage: null,
        output: null,
        pendingApprovalId: "approval-123",
        status: "waiting_approval",
        taskId: "t1"
      },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return {
                handlers: registeredHandlers
              };
            }
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({
      runtimeApi: {
        getTaskSnapshot: () => null,
        registerOutboundAdapter: () => undefined,
        resolveApproval: vi.fn(() => Promise.resolve(null)),
        submitTask,
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    await handlers["im.message.receive_v1"]?.({
      event_id: "event-1",
      message: {
        chat_id: "chat",
        content: JSON.stringify({ text: "create file" }),
        message_id: "message-1"
      },
      sender: {
        sender_id: {
          open_id: "open"
        }
      }
    });

    expect(create).toHaveBeenCalledTimes(2);
    const approvalPayload = create.mock.calls[1]?.[0] as
      | { data: { content: string; msg_type: string; receive_id: string; uuid: string } }
      | undefined;
    expect(approvalPayload?.data.msg_type).toBe("interactive");
    expect(approvalPayload?.data.receive_id).toBe("chat");
    expect(approvalPayload?.data.uuid).toBe("ta-approval-123");
    expect(approvalPayload?.data.content).toContain("approval-123");
    expect(approvalPayload?.data.content).toContain("\"decision\":\"allow\"");
  });

  it("does not send duplicate approval cards for the same pending approval", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "m1" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const submitTask = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: false },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: {
        errorCode: null,
        errorMessage: null,
        output: null,
        pendingApprovalId: "approval-123",
        status: "waiting_approval",
        taskId: "t1"
      },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));

    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => ({ handlers: registeredHandlers })
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({
      runtimeApi: {
        getTaskSnapshot: () => null,
        registerOutboundAdapter: () => undefined,
        resolveApproval: vi.fn(() => Promise.resolve(null)),
        submitTask,
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    await adapter.handleMessageEvent({
      chatId: "chat",
      eventId: "event-1",
      messageId: "message-1",
      openId: "open",
      text: "create file"
    });
    await adapter.handleMessageEvent({
      chatId: "chat",
      eventId: "event-2",
      messageId: "message-2",
      openId: "open",
      text: "create file again"
    });

    const approvalCreates = createPayloads(create).filter((payload) => payload.data.content.includes("approval-123"));
    expect(approvalCreates).toHaveLength(1);
    expect(approvalCreates[0]?.data.uuid).toBe("ta-approval-123");
  });

  it("sends the resumed result after an approval action", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "m1" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const resolveApproval = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: false },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: {
        errorCode: null,
        errorMessage: null,
        output: "file created",
        pendingApprovalId: null,
        status: "succeeded",
        taskId: "t1"
      },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return {
                handlers: registeredHandlers
              };
            }
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({
      runtimeApi: {
        getTaskSnapshot: () => null,
        registerOutboundAdapter: () => undefined,
        resolveApproval,
        submitTask: vi.fn(),
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    await handlers["card.action.trigger"]?.({
      event: {
        action: {
          value: {
            approvalId: "approval-123",
            decision: "allow",
            taskId: "t1"
          }
        },
        context: {
          open_chat_id: "chat",
          open_message_id: "approval-message"
        },
        operator: {
          operator_id: {
            open_id: "open"
          }
        }
      }
    });
    await handlers["card.action.trigger"]?.({
      event: {
        action: {
          value: {
            approvalId: "approval-123",
            decision: "allow",
            taskId: "t1"
          }
        },
        context: {
          open_chat_id: "chat",
          open_message_id: "approval-message"
        },
        operator: {
          operator_id: {
            open_id: "open"
          }
        }
      }
    });

    expect(resolveApproval).toHaveBeenCalledWith({
      adapterId: "feishu-im",
      approvalId: "approval-123",
      decision: "allow",
      reviewerExternalUserId: "open",
      reviewerRuntimeUserId: "feishu-im:open"
    });
    expect(resolveApproval).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[0]?.[0]).toMatchObject({
      path: { message_id: "approval-message" }
    });
    expect(patchContentAt(patch, 0)).toContain("Approval Processing");
    expect(patchContentAt(patch, 1)).toContain("Approved");
    expect(patchContentAt(patch, 1)).not.toContain("\"button\"");
    expect(create).toHaveBeenCalledWith({
      data: {
        content: JSON.stringify({ text: "file created" }),
        msg_type: "text",
        receive_id: "chat",
        uuid: "tr-ok-t1"
      },
      params: {
        receive_id_type: "chat_id"
      }
    });
  });

  it("uses the stored approval card message id when action payload omits it", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ data: { message_id: "task-reply" } })
      .mockResolvedValueOnce({ data: { message_id: "approval-message" } })
      .mockResolvedValue({ data: { message_id: "result-message" } });
    const patch = vi.fn(() => Promise.resolve({}));
    const submitTask = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: false },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: {
        errorCode: null,
        errorMessage: null,
        output: null,
        pendingApprovalId: "approval-123",
        status: "waiting_approval",
        taskId: "t1"
      },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));
    const resolveApproval = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: false },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: {
        errorCode: null,
        errorMessage: null,
        output: "file created",
        pendingApprovalId: null,
        status: "succeeded",
        taskId: "t1"
      },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return {
                handlers: registeredHandlers
              };
            }
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({
      runtimeApi: {
        getTaskSnapshot: () => null,
        registerOutboundAdapter: () => undefined,
        resolveApproval,
        submitTask,
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    await handlers["im.message.receive_v1"]?.({
      event_id: "event-1",
      message: {
        chat_id: "chat",
        content: JSON.stringify({ text: "create file" }),
        message_id: "message-1"
      },
      sender: {
        sender_id: {
          open_id: "open"
        }
      }
    });
    await handlers["card.action.trigger"]?.({
      event: {
        action: {
          value: {
            approvalId: "approval-123",
            decision: "allow",
            taskId: "t1"
          }
        },
        context: {
          open_chat_id: "chat"
        },
        operator: {
          operator_id: {
            open_id: "open"
          }
        }
      }
    });

    expect(patch.mock.calls[0]?.[0]).toMatchObject({
      path: { message_id: "approval-message" }
    });
    expect(patchContentAt(patch, 1)).toContain("Approved");
  });

  it("retries transient message create failures", async () => {
    vi.useFakeTimers();
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
      .mockResolvedValue({ data: { message_id: "m1" } });
    const patch = vi.fn(() => Promise.resolve({}));
    const submitTask = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: true },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: { errorCode: null, errorMessage: null, output: "ok", pendingApprovalId: null, status: "succeeded", taskId: "t1" },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return {
                handlers: registeredHandlers
              };
            }
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({
      runtimeApi: {
        getTaskSnapshot: () => null,
        registerOutboundAdapter: () => undefined,
        resolveApproval: vi.fn(() => Promise.resolve(null)),
        submitTask,
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    const pending = handlers["im.message.receive_v1"]?.({
      event_id: "event-1",
      message: {
        chat_id: "chat",
        content: JSON.stringify({ text: "hello" }),
        message_id: "message-1"
      },
      sender: {
        sender_id: {
          open_id: "open"
        }
      }
    });
    await vi.runAllTimersAsync();
    await pending;

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("reprocesses a redelivered message after reply delivery exhausts retries", async () => {
    vi.useFakeTimers();
    const create = vi.fn(() =>
      Promise.reject(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
    );
    const patch = vi.fn(() => Promise.resolve({}));
    const logger = {
      error: vi.fn()
    };
    const submitTask = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: true },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: { errorCode: null, errorMessage: null, output: "ok", pendingApprovalId: null, status: "succeeded", taskId: "t1" },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        logger,
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return {
                handlers: registeredHandlers
              };
            }
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({
      runtimeApi: {
        getTaskSnapshot: () => null,
        registerOutboundAdapter: () => undefined,
        resolveApproval: vi.fn(() => Promise.resolve(null)),
        submitTask,
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    const payload = {
      event_id: "event-1",
      message: {
        chat_id: "chat",
        content: JSON.stringify({ text: "hello" }),
        message_id: "message-1"
      },
      sender: {
        sender_id: {
          open_id: "open"
        }
      }
    };

    const firstAttempt = handlers["im.message.receive_v1"]?.(payload);
    await vi.runAllTimersAsync();
    await firstAttempt;

    const secondAttempt = handlers["im.message.receive_v1"]?.(payload);
    await vi.runAllTimersAsync();
    await secondAttempt;

    expect(submitTask).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(6);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("redacts secrets from logged errors", async () => {
    const create = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("read ECONNRESET"), {
          code: "ECONNRESET",
          config: {
            headers: {
              Authorization: "Bearer secret-token"
            },
            url: "https://open.feishu.cn/open-apis/im/v1/messages"
          }
        })
      )
    );
    const patch = vi.fn(() => Promise.resolve({}));
    const logger = {
      error: vi.fn()
    };
    const submitTask = vi.fn(() => Promise.resolve({
      adapter: {
        adapterId: "feishu-im",
        capabilities: {
          approvalInteraction: { supported: true },
          attachmentCapability: { supported: true },
          fileCapability: { supported: true },
          streamingCapability: { supported: true },
          structuredCardCapability: { supported: true },
          textInteraction: { supported: true }
        },
        description: "x",
        displayName: "x",
        kind: "sdk" as const,
        lifecycleState: "running" as const
      },
      notices: [],
      result: { errorCode: null, errorMessage: null, output: "ok", pendingApprovalId: null, status: "succeeded", taskId: "t1" },
      sessionBinding: {
        adapterId: "feishu-im",
        createdAt: new Date().toISOString(),
        externalSessionId: "chat",
        externalUserId: "open",
        metadata: {},
        runtimeUserId: "feishu-im:open",
        sessionBindingId: "s1",
        taskId: "t1",
        updatedAt: new Date().toISOString()
      }
    }));

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        logger,
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return {
                handlers: registeredHandlers
              };
            }
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({
      runtimeApi: {
        getTaskSnapshot: () => null,
        registerOutboundAdapter: () => undefined,
        resolveApproval: vi.fn(() => Promise.resolve(null)),
        submitTask,
        subscribeToCompletion: () => () => undefined,
        subscribeToTaskEvents: () => () => undefined
      }
    });

    await handlers["im.message.receive_v1"]?.({
      event_id: "event-1",
      message: {
        chat_id: "chat",
        content: JSON.stringify({ text: "hello" }),
        message_id: "message-1"
      },
      sender: {
        sender_id: {
          open_id: "open"
        }
      }
    });

    const loggedPayload = logger.error.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(JSON.stringify(loggedPayload)).not.toContain("secret-token");
    expect(loggedPayload).toMatchObject({
      code: "ECONNRESET",
      name: "Error",
      url: "https://open.feishu.cn/open-apis/im/v1/messages"
    });
  });

  it("creates schedules from /schedule without submitting a shell task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 28, 9, 15, 0, 0));
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "schedule-reply" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const createSchedule = vi.fn(() =>
      createScheduleRecord({
        input: "say hello",
        nextFireAt: new Date(2026, 3, 28, 9, 16, 0, 0).toISOString(),
        ownerUserId: "feishu-im:open"
      })
    );
    const submitTask = vi.fn();
    const runtimeApi = createRuntimeApi({ createSchedule, submitTask });

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return { handlers: registeredHandlers };
            }
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({ runtimeApi });

    await handlers["im.message.receive_v1"]?.(messagePayload("/schedule create 1分钟后 | say hello"));

    expect(submitTask).not.toHaveBeenCalled();
    expect(createSchedule).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "feishu-im" }), {
      agentProfileId: "executor",
      input: "say hello",
      messageId: "message-1",
      metadata: { source: "feishu_schedule" },
      name: "say hello",
      requester: {
        externalSessionId: "chat",
        externalUserId: "open",
        externalUserLabel: null
      },
      runAt: new Date(2026, 3, 28, 9, 16, 0, 0).toISOString()
    });
    expect(createPayloads(create)[0]).toMatchObject({
      data: {
        msg_type: "text",
        receive_id: "chat"
      }
    });
  });

  it("confirms natural language schedule creation only once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 28, 9, 15, 0, 0));
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "confirmation-message" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const createSchedule = vi.fn(() =>
      createScheduleRecord({
        input: "测试",
        nextFireAt: new Date(2026, 3, 28, 9, 16, 0, 0).toISOString(),
        ownerUserId: "feishu-im:open"
      })
    );
    const runtimeApi = createRuntimeApi({ createSchedule });

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return { handlers: registeredHandlers };
            }
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({ runtimeApi });

    await handlers["im.message.receive_v1"]?.(messagePayload("一分钟后提醒我测试"));
    const content = JSON.parse(createContentAt(create, 0)) as {
      elements: Array<{ actions?: Array<{ value: { confirmationId: string } }> }>;
    };
    const confirmationId = content.elements[2]?.actions?.[0]?.value.confirmationId ?? "";

    const action = {
      event: {
        action: {
          value: {
            actionType: "schedule_confirmation",
            confirmationId,
            decision: "confirm"
          }
        },
        context: {
          open_chat_id: "chat",
          open_message_id: "confirmation-message"
        },
        operator: {
          operator_id: {
            open_id: "open"
          }
        }
      }
    };
    await handlers["card.action.trigger"]?.(action);
    await handlers["card.action.trigger"]?.(action);

    expect(createSchedule).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patchContentAt(patch, 0)).toContain("Scheduling");
    expect(patchContentAt(patch, 1)).toContain("Schedule Created");
    expect(patchContentAt(patch, 1)).not.toContain("\"button\"");
  });

  it("cancels natural language schedule confirmation without creating a schedule", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "confirmation-message" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const createSchedule = vi.fn();
    const runtimeApi = createRuntimeApi({ createSchedule });

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({
            register: (registeredHandlers) => {
              handlers = registeredHandlers;
              return { handlers: registeredHandlers };
            }
          }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({ runtimeApi });

    await handlers["im.message.receive_v1"]?.(messagePayload("1分钟后帮我执行测试"));
    const content = JSON.parse(createContentAt(create, 0)) as {
      elements: Array<{ actions?: Array<{ value: { confirmationId: string } }> }>;
    };
    const confirmationId = content.elements[2]?.actions?.[1]?.value.confirmationId ?? "";

    await handlers["card.action.trigger"]?.({
      event: {
        action: {
          value: {
            actionType: "schedule_confirmation",
            confirmationId,
            decision: "cancel"
          }
        },
        context: {
          open_chat_id: "chat",
          open_message_id: "confirmation-message"
        }
      }
    });

    expect(createSchedule).not.toHaveBeenCalled();
    expect(patchContentAt(patch, 0)).toContain("Schedule Cancelled");
    expect(patchContentAt(patch, 0)).not.toContain("\"button\"");
  });

  it("sends Feishu-origin schedule completion inbox events back to the original chat", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "completion-message" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const runtimeApi = createRuntimeApi({
      getTaskSnapshot: () => ({
        adapterSource: null,
        audit: [],
        notices: [],
        task: {
          errorCode: null,
          errorMessage: null,
          output: "routine output",
          pendingApprovalId: null,
          status: "succeeded",
          taskId: "task-1"
        },
        trace: []
      })
    });
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({ register: (registeredHandlers) => ({ handlers: registeredHandlers }) }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({ runtimeApi });

    await adapter.sendInboxEvent({
      kind: "created",
      item: createInboxItem({
        category: "task_completed",
        metadata: {
          origin: {
            adapter: "feishu-im",
            chatId: "chat"
          },
          scheduleId: "schedule-1"
        },
        summary: "fallback summary",
        taskId: "task-1",
        title: "Routine completed: check"
      })
    });

    expect(createPayloads(create)[0]).toMatchObject({
      data: {
        content: JSON.stringify({ text: "Routine completed: Routine completed: check\nroutine output" }),
        msg_type: "text",
        receive_id: "chat"
      }
    });
  });

  it("ignores non-Feishu schedule inbox events", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "completion-message" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({ register: (registeredHandlers) => ({ handlers: registeredHandlers }) }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({ runtimeApi: createRuntimeApi() });

    await adapter.sendInboxEvent({
      kind: "created",
      item: createInboxItem({
        category: "task_completed",
        metadata: {},
        summary: "local summary",
        taskId: "task-1"
      })
    });

    expect(create).not.toHaveBeenCalled();
  });

  it("sends approval cards for Feishu-origin schedule approval inbox events", async () => {
    const create = vi.fn(() => Promise.resolve({ data: { message_id: "approval-message" } }));
    const patch = vi.fn(() => Promise.resolve({}));
    const runtimeApi = createRuntimeApi({
      getTaskSnapshot: () => ({
        adapterSource: null,
        audit: [],
        notices: [],
        task: {
          errorCode: null,
          errorMessage: null,
          output: null,
          pendingApprovalId: "approval-1",
          status: "waiting_approval",
          taskId: "task-1"
        },
        trace: []
      })
    });
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () => Promise.resolve({
          client: { im: { message: { create, patch } } },
          createEventDispatcher: () => ({ register: (registeredHandlers) => ({ handlers: registeredHandlers }) }),
          wsClient: { start: vi.fn() }
        })
      }
    );
    await adapter.start({ runtimeApi });

    await adapter.sendInboxEvent({
      kind: "created",
      item: createInboxItem({
        approvalId: "approval-1",
        category: "approval_requested",
        metadata: {
          origin: {
            adapter: "feishu-im",
            chatId: "chat"
          },
          scheduleId: "schedule-1"
        },
        severity: "action_required",
        summary: "shell requires approval",
        taskId: "task-1"
      })
    });

    const payload = createPayloads(create)[0];
    expect(payload).toMatchObject({
      data: {
        msg_type: "interactive",
        receive_id: "chat",
        uuid: "ta-approval-1"
      }
    });
    expect(payload?.data.content).toContain("approval-1");
  });
});

interface FeishuTestCreatePayload {
  data: {
    content: string;
    msg_type: string;
    receive_id: string;
    uuid: string;
  };
  params: {
    receive_id_type: string;
  };
}

interface FeishuTestPatchPayload {
  data: {
    content: string;
  };
  path: {
    message_id: string;
  };
}

interface MockCallStore<TArgs extends unknown[]> {
  mock: {
    calls: TArgs[];
  };
}

function createPayloads(mock: unknown): FeishuTestCreatePayload[] {
  return (mock as MockCallStore<[FeishuTestCreatePayload]>).mock.calls.map((call) => call[0]);
}

function createContentAt(mock: unknown, index: number): string {
  return createPayloads(mock)[index]?.data.content ?? "";
}

function patchContentAt(mock: unknown, index: number): string {
  const calls = (mock as MockCallStore<[FeishuTestPatchPayload]>).mock.calls;
  return calls[index]?.[0].data.content ?? "";
}

function messagePayload(text: string): unknown {
  return {
    event_id: "event-1",
    message: {
      chat_id: "chat",
      content: JSON.stringify({ text }),
      message_id: "message-1"
    },
    sender: {
      sender_id: {
        open_id: "open"
      }
    }
  };
}

function createRuntimeApi(overrides: Partial<GatewayRuntimeApi> = {}): GatewayRuntimeApi {
  return {
    createSchedule: vi.fn(() => createScheduleRecord()),
    getTaskSnapshot: () => null,
    listInbox: vi.fn(() => []),
    listScheduleRuns: vi.fn(() => []),
    listSchedules: vi.fn(() => []),
    markInboxDone: vi.fn(),
    pauseSchedule: vi.fn((scheduleId: string) => ({ ...createScheduleRecord({ scheduleId }), status: "paused" })),
    registerOutboundAdapter: () => undefined,
    resolveApproval: vi.fn(() => Promise.resolve(null)),
    resumeSchedule: vi.fn((scheduleId: string) => ({ ...createScheduleRecord({ scheduleId }), status: "active" })),
    runScheduleNow: vi.fn((): ScheduleRunRecord => ({
      attemptNumber: 1,
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
      metadata: {},
      runId: "run-1",
      scheduleId: "schedule-1",
      scheduledAt: new Date().toISOString(),
      startedAt: null,
      status: "queued",
      taskId: null,
      threadId: null,
      trigger: "manual"
    })),
    showSchedule: vi.fn(() => createScheduleRecord()),
    submitTask: vi.fn(),
    subscribeToCompletion: () => () => undefined,
    subscribeToInbox: () => () => undefined,
    subscribeToTaskEvents: () => () => undefined,
    ...overrides
  };
}

function createScheduleRecord(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    agentProfileId: "executor",
    backoffBaseMs: 5_000,
    backoffMaxMs: 300_000,
    createdAt: new Date().toISOString(),
    cron: null,
    cwd: "/tmp",
    input: "scheduled task",
    intervalMs: null,
    lastFireAt: null,
    maxAttempts: 3,
    metadata: {},
    name: "scheduled task",
    nextFireAt: null,
    ownerUserId: "feishu-im:open",
    providerName: "mock",
    runAt: null,
    scheduleId: "schedule-12345678",
    status: "active",
    threadId: null,
    timezone: null,
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function createInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    actionHint: null,
    approvalId: null,
    bodyMd: null,
    category: "task_completed",
    createdAt: new Date().toISOString(),
    dedupKey: null,
    doneAt: null,
    experienceId: null,
    inboxId: "inbox-1",
    metadata: {},
    scheduleRunId: "run-1",
    severity: "info",
    skillId: null,
    sourceTraceId: null,
    status: "pending",
    summary: "summary",
    taskId: null,
    threadId: null,
    title: "title",
    updatedAt: new Date().toISOString(),
    userId: "feishu-im:open",
    ...overrides
  };
}
