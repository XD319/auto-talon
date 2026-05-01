export function renderTaskAcceptedCard(taskId: string, input: string): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: `Task accepted: \`${taskId}\`` },
      { tag: "markdown", content: input.slice(0, 300) }
    ],
    header: { title: { content: "Auto Talon Task", tag: "plain_text" } }
  });
}

export function renderTaskProgressCard(taskId: string, detail: string): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [{ tag: "markdown", content: `Task \`${taskId}\` progress: ${detail}` }],
    header: { title: { content: "Task Progress", tag: "plain_text" } }
  });
}

export function renderTaskResultCard(output: string | null): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: output === null || output.trim().length === 0 ? "_没有返回内容_" : output.slice(0, 1000) }
    ]
  });
}

export function renderApprovalCard(taskId: string, approvalId: string): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: `Task \`${taskId}\` requires approval.` },
      {
        actions: [
          {
            tag: "button",
            text: { content: "Approve", tag: "plain_text" },
            type: "primary",
            value: { approvalId, decision: "allow", taskId }
          },
          {
            tag: "button",
            text: { content: "Deny", tag: "plain_text" },
            type: "danger",
            value: { approvalId, decision: "deny", taskId }
          }
        ],
        tag: "action"
      }
    ],
    header: { title: { content: "Approval Required", tag: "plain_text" } }
  });
}

export function renderApprovalProcessingCard(
  taskId: string,
  approvalId: string,
  decision: "allow" | "deny"
): string {
  const label = decision === "allow" ? "approval" : "denial";
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      {
        tag: "markdown",
        content: `Task \`${taskId}\` ${label} is being processed.\nApproval: \`${approvalId}\``
      }
    ],
    header: { title: { content: "Approval Processing", tag: "plain_text" } }
  });
}

export function renderApprovalResolvedCard(
  taskId: string,
  approvalId: string,
  decision: "allow" | "deny"
): string {
  const label = decision === "allow" ? "Approved" : "Denied";
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      {
        tag: "markdown",
        content: `Task \`${taskId}\` ${label.toLowerCase()}.\nApproval: \`${approvalId}\``
      }
    ],
    header: { title: { content: label, tag: "plain_text" } }
  });
}

export function renderApprovalFailedCard(taskId: string, approvalId: string, message: string): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      {
        tag: "markdown",
        content: `Task \`${taskId}\` approval could not be processed.\nApproval: \`${approvalId}\`\n${message.slice(0, 500)}`
      }
    ],
    header: { title: { content: "Approval Failed", tag: "plain_text" } }
  });
}

export function renderScheduleConfirmationCard(input: {
  confirmationId: string;
  prompt: string;
  whenText: string;
}): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: `Create scheduled task?\nTime: \`${input.whenText}\`` },
      { tag: "markdown", content: input.prompt.slice(0, 1000) },
      {
        actions: [
          {
            tag: "button",
            text: { content: "Confirm", tag: "plain_text" },
            type: "primary",
            value: { actionType: "schedule_confirmation", confirmationId: input.confirmationId, decision: "confirm" }
          },
          {
            tag: "button",
            text: { content: "Cancel", tag: "plain_text" },
            type: "default",
            value: { actionType: "schedule_confirmation", confirmationId: input.confirmationId, decision: "cancel" }
          }
        ],
        tag: "action"
      }
    ],
    header: { title: { content: "Schedule Confirmation", tag: "plain_text" } }
  });
}

export function renderScheduleConfirmationProcessingCard(whenText: string, prompt: string): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: `Scheduling task for \`${whenText}\`...` },
      { tag: "markdown", content: prompt.slice(0, 1000) }
    ],
    header: { title: { content: "Scheduling", tag: "plain_text" } }
  });
}

export function renderScheduleCreatedCard(input: {
  name: string;
  nextFireAt: string | null;
  scheduleId: string;
}): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      {
        tag: "markdown",
        content: `Scheduled \`${input.scheduleId.slice(0, 8)}\` | ${input.name}\nNext: ${
          input.nextFireAt ?? "none"
        }`
      }
    ],
    header: { title: { content: "Schedule Created", tag: "plain_text" } }
  });
}

export function renderScheduleCancelledCard(whenText: string, prompt: string): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: `Schedule creation cancelled.\nTime: \`${whenText}\`` },
      { tag: "markdown", content: prompt.slice(0, 1000) }
    ],
    header: { title: { content: "Schedule Cancelled", tag: "plain_text" } }
  });
}

export function renderScheduleFailedCard(message: string): string {
  return JSON.stringify({
    config: { update_multi: true, wide_screen_mode: true },
    elements: [{ tag: "markdown", content: message.slice(0, 1000) }],
    header: { title: { content: "Schedule Failed", tag: "plain_text" } }
  });
}
