import React from "react";
import { Box, Text } from "ink";

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

export interface MessageStreamPartition {
  dynamicMessages: ChatMessage[];
  stableMessages: ChatMessage[];
}

// A message is considered "stable" once it can no longer change. Older stable
// messages are committed via Ink's <Static> so they are written to the terminal
// exactly once. The newest visible stable message stays in the dynamic region so
// a just-completed assistant response remains visible in the active TUI frame.
function isMessageStable(message: ChatMessage): boolean {
  if (message.kind === "agent") {
    return message.streaming !== true;
  }
  if (message.kind === "approval") {
    return message.status !== "pending";
  }
  return true;
}

export function splitMessageStreamMessages(messages: ChatMessage[]): MessageStreamPartition {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined || !isMessageStable(message)) {
      return {
        dynamicMessages: messages.slice(index),
        stableMessages: messages.slice(0, index)
      };
    }
  }

  const stablePrefixCount = Math.max(0, messages.length - 1);
  return {
    dynamicMessages: messages.slice(stablePrefixCount),
    stableMessages: messages.slice(0, stablePrefixCount)
  };
}

export function MessageStream({ messages }: MessageStreamProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
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
