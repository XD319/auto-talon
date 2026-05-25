import React from "react";
import { Box, Static, Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize.js";
import { theme } from "../theme.js";
import type { ChatMessage } from "../view-models/chat-messages.js";
import type { TraceEvent } from "../../types/index.js";
import { AgentMessage } from "./agent-message.js";
import { ApprovalCard } from "./approval-card.js";
import { ErrorMessage } from "./error-message.js";
import { UserMessage } from "./user-message.js";

export interface MessageStreamProps {
  messages: ChatMessage[];
}

// A message is considered "stable" once it can no longer change. Stable
// messages are committed via Ink's <Static> so they are written to the terminal
// exactly once. This is what stops long transcripts from being re-printed on
// every streaming tick — the previous behaviour caused visible duplication on
// terminals where the frame height exceeds the window height (PowerShell /
// ConHost are particularly prone to this).
function isMessageStable(message: ChatMessage): boolean {
  if (message.kind === "agent") {
    return message.streaming !== true;
  }
  if (message.kind === "approval") {
    return message.status !== "pending";
  }
  return true;
}

export function MessageStream({ messages }: MessageStreamProps): React.ReactElement {
  // Stable region is always a contiguous prefix of `messages`. We stop walking
  // at the first non-stable message so that anything appearing *after* an
  // in-flight item stays in the dynamic region until it itself becomes stable.
  const stableCount = React.useMemo(() => {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message === undefined || !isMessageStable(message)) {
        return index;
      }
    }
    return messages.length;
  }, [messages]);

  const stableMessages = messages.slice(0, stableCount);
  const dynamicMessages = messages.slice(stableCount);

  // <Static> is append-only: items already committed to the terminal cannot be
  // unrendered. When the transcript is replaced (clear / restoreSession / new
  // thread) we want a fresh Static instance, so we key it on the first stable
  // message id. Inside a single conversation that id never changes (the first
  // user prompt anchors the transcript), so streaming updates do not force a
  // remount. Switching to a different conversation or clearing the chat
  // changes the first id, which mounts a new Static and gives us a clean
  // surface to draw on.
  const staticKey = stableMessages[0]?.id ?? "empty";

  return (
    <Box flexDirection="column">
      {stableMessages.length > 0 ? (
        <Static key={staticKey} items={stableMessages}>
          {(message, index) => (
            <Box key={message.id} flexDirection="column">
              {needsTurnSeparator(stableMessages[index - 1], message) ? (
                <Text color={theme.muted}> </Text>
              ) : null}
              <MessageItem message={message} />
            </Box>
          )}
        </Static>
      ) : null}
      {dynamicMessages.map((message, index) => {
        const previous =
          index === 0
            ? stableMessages[stableMessages.length - 1]
            : dynamicMessages[index - 1];
        return (
          <React.Fragment key={message.id}>
            {needsTurnSeparator(previous, message) ? <Text color={theme.muted}> </Text> : null}
            <MessageItem message={message} />
          </React.Fragment>
        );
      })}
    </Box>
  );
}

function MessageItem({ message }: { message: ChatMessage }): React.ReactElement {
  if (message.kind === "user") {
    return <UserMessage text={message.text} />;
  }
  if (message.kind === "agent") {
    return (
      <AgentMessage
        {...(message.streaming === true ? { streaming: true } : {})}
        text={message.text}
      />
    );
  }
  if (message.kind === "approval") {
    if (message.status === "resolved") {
      const action = message.resolution ?? "allow";
      const label = action === "allow" ? "Approved" : "Denied";
      return (
        <Text color={action === "allow" ? theme.success : theme.danger}>
          [approval] {label} {message.approval.toolName} for task {message.approval.taskId.slice(0, 8)}.
        </Text>
      );
    }

    return (
      <Box marginY={1}>
        <ApprovalCard
          approval={message.approval}
          toolCall={message.toolCall}
        />
      </Box>
    );
  }
  if (message.kind === "approval_result") {
    return (
      <Text color={message.action === "allow" ? theme.success : theme.danger}>
        [approval] {message.text}
      </Text>
    );
  }
  if (message.kind === "error") {
    return (
      <ErrorMessage
        code={message.code}
        message={message.message}
        source={message.source}
      />
    );
  }
  if (message.kind === "activity") {
    return (
      <Text color={activityColor(message.event.eventType)} wrap="wrap">
        {activityPrefix(message.event.eventType)} {sanitizeTerminalText(message.text)}
      </Text>
    );
  }
  return <Text color={theme.muted}>{sanitizeTerminalText(message.text)}</Text>;
}

function needsTurnSeparator(previous: ChatMessage | undefined, current: ChatMessage): boolean {
  if (previous === undefined) {
    return false;
  }
  const turnKinds = new Set(["user", "agent"]);
  return turnKinds.has(previous.kind) && turnKinds.has(current.kind) && previous.kind !== current.kind;
}

function activityPrefix(eventType: TraceEvent["eventType"]): string {
  if (eventType === "tool_call_requested" || eventType === "tool_call_started" || eventType === "tool_call_finished") {
    return ">";
  }
  if (eventType === "tool_call_failed" || eventType === "provider_request_failed") {
    return "x";
  }
  if (
    eventType === "approval_requested" ||
    eventType === "approval_resolved" ||
    eventType === "clarify_requested" ||
    eventType === "clarify_resolved" ||
    eventType === "clarify_cancelled"
  ) {
    return "!";
  }
  return "-";
}

function activityColor(eventType: TraceEvent["eventType"]): string {
  if (eventType === "tool_call_failed" || eventType === "provider_request_failed") {
    return theme.danger;
  }
  if (
    eventType === "approval_requested" ||
    eventType === "clarify_requested" ||
    eventType === "clarify_resolved" ||
    eventType === "clarify_cancelled" ||
    eventType === "retry" ||
    eventType === "sandbox_enforced"
  ) {
    return theme.warn;
  }
  return theme.muted;
}
