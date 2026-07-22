import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuAdapter } from "../src/gateway/index.js";
import type { GatewayRuntimeApi, GatewayTaskLaunchResult } from "../src/types/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feishu gateway e2e (mocked SDK)", () => {
  it("runs message → approval card → allow → completion result", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ data: { message_id: "task-reply" } })
      .mockResolvedValueOnce({ data: { message_id: "approval-message" } })
      .mockResolvedValue({ data: { message_id: "result-message" } });
    const patch = vi.fn(() => Promise.resolve({}));
    const wsStart = vi.fn(() => Promise.resolve());
    const wsStop = vi.fn();

    const waitingApproval: GatewayTaskLaunchResult = {
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
        kind: "sdk",
        lifecycleState: "running"
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
    };

    const completed: GatewayTaskLaunchResult = {
      ...waitingApproval,
      result: {
        errorCode: null,
        errorMessage: null,
        output: "file created after approval",
        pendingApprovalId: null,
        status: "succeeded",
        taskId: "t1"
      }
    };

    const submitTask = vi.fn(() => Promise.resolve(waitingApproval));
    const resolveApproval = vi.fn(() => Promise.resolve(completed));

    let handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
    const adapter = new FeishuAdapter(
      { appId: "app", appSecret: "secret", domain: "feishu" },
      {
        createClients: () =>
          Promise.resolve({
            client: { im: { message: { create, patch } } },
            createEventDispatcher: () => ({
              register: (registeredHandlers) => {
                handlers = registeredHandlers;
                return { handlers: registeredHandlers };
              }
            }),
            wsClient: { start: wsStart, stop: wsStop }
          })
      }
    );

    const runtimeApi = {
      getTaskSnapshot: () => null,
      registerOutboundAdapter: () => undefined,
      resolveApproval,
      submitTask,
      subscribeToCompletion: () => () => undefined,
      subscribeToTaskEvents: () => () => undefined
    } as unknown as GatewayRuntimeApi;
    await adapter.start({ runtimeApi });
    expect(wsStart).toHaveBeenCalledTimes(1);

    await handlers["im.message.receive_v1"]?.({
      event_id: "event-e2e-1",
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

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    const approvalPayload = create.mock.calls[1]?.[0] as
      | { data: { content: string; msg_type: string; receive_id: string; uuid: string } }
      | undefined;
    expect(approvalPayload?.data.msg_type).toBe("interactive");
    expect(approvalPayload?.data.receive_id).toBe("chat");
    expect(approvalPayload?.data.uuid).toBe("ta-approval-123");
    expect(approvalPayload?.data.content).toContain("approval-123");
    expect(approvalPayload?.data.content).toContain("\"decision\":\"allow\"");

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

    const resultCreate = create.mock.calls.find((call) => {
      const payload = call[0] as { data?: { content?: string; msg_type?: string; uuid?: string } } | undefined;
      return payload?.data?.msg_type === "text" && payload.data.uuid === "tr-ok-t1";
    });
    expect(resultCreate?.[0]).toMatchObject({
      data: {
        content: JSON.stringify({ text: "file created after approval" }),
        msg_type: "text",
        receive_id: "chat",
        uuid: "tr-ok-t1"
      },
      params: {
        receive_id_type: "chat_id"
      }
    });

    const approvalPatches = patch.mock.calls.filter((call) => {
      const payload = call[0] as { path?: { message_id?: string } } | undefined;
      return payload?.path?.message_id === "approval-message";
    });
    expect(approvalPatches.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(approvalPatches.at(-1)?.[0])).toContain("Approved");

    await adapter.stop();
    expect(wsStop).toHaveBeenCalledTimes(1);
  });
});
