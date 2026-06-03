import React from "react";

import {
  measureChatMessage,
  type MessageMeasurement
} from "../components/message-stream.js";
import type { ChatMessage } from "../view-models/chat-messages.js";

export type TranscriptFollowMode = "sticky-bottom" | "manual" | "completion-anchor";

export interface TranscriptScrollState {
  followMode: TranscriptFollowMode;
  manual: boolean;
  pendingCompletionAnchor: { messageId: string } | null;
  scrollTop: number;
  sticky: boolean;
  viewportHeight: number;
}

export interface VirtualHistoryItem {
  measurement: MessageMeasurement;
  message?: ChatMessage;
  offsetTop: number;
  rowEnd: number;
  rowStart: number;
}

export interface VirtualHistoryWindow {
  items: VirtualHistoryItem[];
  maxScrollTop: number;
  bottomSpacerRows: number;
  scrollTop: number;
  topSpacerRows: number;
  totalHeight: number;
}

export interface UseVirtualHistoryInput {
  busy: boolean;
  messages: ChatMessage[];
  overscanRows?: number;
  runState: string;
  viewportHeight: number;
  width: number;
}

export interface VirtualHistoryController {
  jumpTo: (target: "start" | "end") => void;
  resetToBottom: () => void;
  scrollPage: (direction: -1 | 1, accelerated: boolean) => void;
  state: TranscriptScrollState;
  window: VirtualHistoryWindow;
}

interface TopAnchor {
  messageId: string;
  rowOffset: number;
}

const DEFAULT_OVERSCAN_ROWS = 3;

export function selectVirtualHistoryWindow(
  measurements: MessageMeasurement[],
  scrollTop: number,
  viewportHeight: number,
  overscanRows: number
): VirtualHistoryWindow {
  const safeViewportHeight = Math.max(1, Math.floor(viewportHeight));
  const safeOverscanRows = Math.max(0, Math.floor(overscanRows));
  const totalHeight = measurements.reduce((sum, item) => sum + item.height, 0);
  const maxScrollTop = Math.max(0, totalHeight - safeViewportHeight);
  const safeScrollTop = clampScrollTop(scrollTop, totalHeight, safeViewportHeight);
  const visibleStart = Math.max(0, safeScrollTop - safeOverscanRows);
  const visibleEnd = Math.min(totalHeight, safeScrollTop + safeViewportHeight + safeOverscanRows);
  const items: VirtualHistoryItem[] = [];

  let offset = 0;
  for (let index = 0; index < measurements.length; index += 1) {
    const measurement = measurements[index];
    if (measurement === undefined) {
      continue;
    }
    const nextOffset = offset + measurement.height;
    if (nextOffset > visibleStart && offset < visibleEnd) {
      items.push({
        measurement,
        offsetTop: offset,
        rowEnd: Math.min(measurement.height, Math.max(0, visibleEnd - offset)),
        rowStart: Math.max(0, visibleStart - offset)
      });
    }
    offset = nextOffset;
  }

  const first = items[0];
  const last = items.at(-1);
  return {
    bottomSpacerRows:
      last === undefined ? Math.max(0, totalHeight - visibleEnd) : Math.max(0, totalHeight - (last.offsetTop + last.rowEnd)),
    items,
    maxScrollTop,
    scrollTop: safeScrollTop,
    topSpacerRows: first === undefined ? visibleStart : first.offsetTop + first.rowStart,
    totalHeight
  };
}

export function attachMessagesToVirtualWindow(
  window: VirtualHistoryWindow,
  messages: ChatMessage[]
): VirtualHistoryWindow {
  const items: VirtualHistoryItem[] = [];
  for (const item of window.items) {
    const message = messages.find((entry) => entry.id === item.measurement.id);
    if (message !== undefined) {
      items.push({ ...item, message });
    }
  }
  return {
    ...window,
    items
  };
}

export function clampScrollTop(scrollTop: number, totalHeight: number, viewportHeight: number): number {
  if (!Number.isFinite(scrollTop)) {
    return 0;
  }
  const maxScrollTop = Math.max(0, Math.floor(totalHeight) - Math.max(1, Math.floor(viewportHeight)));
  return Math.max(0, Math.min(Math.floor(scrollTop), maxScrollTop));
}

export function findLatestCompletedAssistantMessageId(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "agent" && message.streaming !== true) {
      return message.id;
    }
  }
  return null;
}

export function useVirtualHistory(input: UseVirtualHistoryInput): VirtualHistoryController {
  const overscanRows = input.overscanRows ?? DEFAULT_OVERSCAN_ROWS;
  const measurementCacheRef = React.useRef<Map<string, MessageMeasurement>>(new Map());
  const previousBusyRef = React.useRef(input.busy);
  const previousMessagesKeyRef = React.useRef("");
  const topAnchorRef = React.useRef<TopAnchor | null>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [followMode, setFollowMode] = React.useState<TranscriptFollowMode>("sticky-bottom");
  const [pendingCompletionAnchor, setPendingCompletionAnchor] = React.useState<{ messageId: string } | null>(null);

  const measurements = React.useMemo(() => {
    const cache = measurementCacheRef.current;
    const liveKeys = new Set<string>();
    const next: MessageMeasurement[] = [];
    for (let index = 0; index < input.messages.length; index += 1) {
      const message = input.messages[index];
      if (message === undefined) {
        continue;
      }
      const measured = measureChatMessage(message, input.width, input.messages[index - 1]);
      const key = measurementCacheKey(measured);
      liveKeys.add(key);
      const cached = cache.get(key);
      const measurement = cached ?? measured;
      if (cached === undefined) {
        cache.set(key, measurement);
      }
      next.push(measurement);
    }
    for (const key of cache.keys()) {
      if (!liveKeys.has(key)) {
        cache.delete(key);
      }
    }
    return next;
  }, [input.messages, input.width]);

  const totalHeight = React.useMemo(
    () => measurements.reduce((sum, item) => sum + item.height, 0),
    [measurements]
  );
  const maxScrollTop = Math.max(0, totalHeight - Math.max(1, Math.floor(input.viewportHeight)));
  const sticky = followMode === "sticky-bottom";
  const manual = followMode === "manual";

  React.useEffect(() => {
    const nextKey = input.messages.map((message) => message.id).join("\u0000");
    if (previousMessagesKeyRef.current.length > 0 && nextKey !== previousMessagesKeyRef.current) {
      if (followMode === "sticky-bottom") {
        setScrollTop(maxScrollTop);
      } else {
        const anchor = topAnchorRef.current;
        if (anchor !== null) {
          const offset = findMeasurementOffset(measurements, anchor.messageId);
          setScrollTop(offset === null ? (current) => clampScrollTop(current, totalHeight, input.viewportHeight) : offset + anchor.rowOffset);
        } else {
          setScrollTop((current) => clampScrollTop(current, totalHeight, input.viewportHeight));
        }
      }
    }
    previousMessagesKeyRef.current = nextKey;
  }, [followMode, input.messages, input.viewportHeight, maxScrollTop, measurements, totalHeight]);

  React.useEffect(() => {
    if (followMode === "sticky-bottom") {
      setScrollTop(maxScrollTop);
      return;
    }
    if (followMode === "completion-anchor" && pendingCompletionAnchor !== null) {
      const offset = findMeasurementOffset(measurements, pendingCompletionAnchor.messageId);
      if (offset !== null) {
        setScrollTop(clampScrollTop(offset, totalHeight, input.viewportHeight));
        setPendingCompletionAnchor(null);
      }
      return;
    }
    setScrollTop((current) => clampScrollTop(current, totalHeight, input.viewportHeight));
  }, [followMode, input.viewportHeight, maxScrollTop, measurements, pendingCompletionAnchor, totalHeight]);

  React.useEffect(() => {
    const wasBusy = previousBusyRef.current;
    if (!wasBusy && input.busy) {
      setFollowMode("sticky-bottom");
      setPendingCompletionAnchor(null);
      setScrollTop(maxScrollTop);
    }
    if (wasBusy && !input.busy && input.runState === "succeeded" && followMode !== "manual") {
      const messageId = findLatestCompletedAssistantMessageId(input.messages);
      if (messageId !== null) {
        setFollowMode("completion-anchor");
        setPendingCompletionAnchor({ messageId });
      }
    }
    previousBusyRef.current = input.busy;
  }, [followMode, input.busy, input.messages, input.runState, maxScrollTop]);

  const rawWindow = React.useMemo(
    () => selectVirtualHistoryWindow(measurements, scrollTop, input.viewportHeight, overscanRows),
    [input.viewportHeight, measurements, overscanRows, scrollTop]
  );
  const window = React.useMemo(
    () => attachMessagesToVirtualWindow(rawWindow, input.messages),
    [input.messages, rawWindow]
  );

  React.useEffect(() => {
    topAnchorRef.current = topAnchorFromWindow(window);
  }, [window]);

  const scrollPage = React.useCallback(
    (direction: -1 | 1, accelerated: boolean) => {
      const pageRows = Math.max(1, Math.floor(input.viewportHeight) - 1);
      const delta = accelerated ? pageRows * 2 : pageRows;
      setScrollTop((current) => {
        const next = clampScrollTop(current + direction * delta, totalHeight, input.viewportHeight);
        if (next >= maxScrollTop) {
          setFollowMode("sticky-bottom");
          setPendingCompletionAnchor(null);
        } else {
          setFollowMode("manual");
          setPendingCompletionAnchor(null);
        }
        return next;
      });
    },
    [input.viewportHeight, maxScrollTop, totalHeight]
  );

  const jumpTo = React.useCallback(
    (target: "start" | "end") => {
      if (target === "end") {
        setFollowMode("sticky-bottom");
        setPendingCompletionAnchor(null);
        setScrollTop(maxScrollTop);
        return;
      }
      setFollowMode("manual");
      setPendingCompletionAnchor(null);
      setScrollTop(0);
    },
    [maxScrollTop]
  );

  const resetToBottom = React.useCallback(() => {
    setFollowMode("sticky-bottom");
    setPendingCompletionAnchor(null);
    setScrollTop(maxScrollTop);
  }, [maxScrollTop]);

  return {
    jumpTo,
    resetToBottom,
    scrollPage,
    state: {
      followMode,
      manual,
      pendingCompletionAnchor,
      scrollTop: window.scrollTop,
      sticky,
      viewportHeight: Math.max(1, Math.floor(input.viewportHeight))
    },
    window
  };
}

function measurementCacheKey(measurement: MessageMeasurement): string {
  return [measurement.id, measurement.revision, measurement.width].join("\u0000");
}

function findMeasurementOffset(measurements: MessageMeasurement[], messageId: string): number | null {
  let offset = 0;
  for (const measurement of measurements) {
    if (measurement.id === messageId) {
      return offset;
    }
    offset += measurement.height;
  }
  return null;
}

function topAnchorFromWindow(window: VirtualHistoryWindow): TopAnchor | null {
  const first = window.items[0];
  if (first === undefined) {
    return null;
  }
  return {
    messageId: first.message?.id ?? first.measurement.id,
    rowOffset: first.rowStart
  };
}
