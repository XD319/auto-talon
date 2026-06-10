import React from "react";
import { useStdout } from "ink";

import type { DiffDisplayMode } from "../../presentation/diff-display.js";
import type { RuntimeOutputEvent, TraceEvent } from "../../types/index.js";
import type { ChatMessage } from "../view-models/chat-messages.js";
import {
  formatScrollbackMessage,
  formatScrollbackOutputEvent,
  updateScrollbackToolState,
  type ScrollbackToolState,
  type ScrollbackTurnState,
  wrapScrollbackChunk,
  type ScrollbackWrapState
} from "../view-models/scrollback-transcript.js";

export interface ScrollbackTranscriptController {
  print: (text: string) => void;
  onOutputEvent: (event: RuntimeOutputEvent) => void;
  onTraceEvent: (event: TraceEvent) => void;
  replayMessages: (messages: ChatMessage[]) => void;
}

export function useScrollbackTranscript(
  messages: ChatMessage[],
  diffDisplay: DiffDisplayMode = "collapsed"
): ScrollbackTranscriptController {
  const { stdout, write } = useStdout();
  const printedMessagesRef = React.useRef<Set<string>>(new Set());
  const printedOutputEventsRef = React.useRef<Set<string>>(new Set());
  const printedTraceEventsRef = React.useRef<Set<string>>(new Set());
  const turnsRef = React.useRef<Map<string, ScrollbackTurnState>>(new Map());
  const toolsRef = React.useRef<Map<string, ScrollbackToolState>>(new Map());
  const wrapStateRef = React.useRef<ScrollbackWrapState>({ column: 0, pending: "" });
  const writeQueueRef = React.useRef("");
  const flushingRef = React.useRef(false);

  const flush = React.useCallback(() => {
    if (flushingRef.current || writeQueueRef.current.length === 0) {
      return;
    }
    flushingRef.current = true;
    const chunk = writeQueueRef.current;
    writeQueueRef.current = "";
    write(chunk);
    flushingRef.current = false;
    if (writeQueueRef.current.length > 0) {
      queueMicrotask(flush);
    }
  }, [write]);

  const terminalColumns = React.useCallback(() => {
    return stdout.columns ?? process.stdout.columns ?? 80;
  }, [stdout]);

  const enqueue = React.useCallback(
    (chunk: string) => {
      if (chunk.length === 0) {
        return;
      }
      writeQueueRef.current += chunk;
      queueMicrotask(flush);
    },
    [flush]
  );

  const writeWrapped = React.useCallback(
    (text: string, options: { breakBefore?: boolean; flushPartial?: boolean } = {}) => {
      if (options.breakBefore === true && wrapStateRef.current.pending.length > 0) {
        enqueue(wrapScrollbackChunk("", wrapStateRef.current, terminalColumns(), { flushPartial: true }));
      }
      enqueue(
        wrapScrollbackChunk(text, wrapStateRef.current, terminalColumns(), {
          flushPartial: options.flushPartial === true
        })
      );
    },
    [enqueue, terminalColumns]
  );

  const print = React.useCallback(
    (text: string) => {
      if (text.length === 0) {
        return;
      }
      writeWrapped(text, { breakBefore: true, flushPartial: true });
    },
    [writeWrapped]
  );

  const printStream = React.useCallback(
    (text: string) => {
      writeWrapped(text);
    },
    [writeWrapped]
  );

  const printRecord = React.useCallback(
    (text: string) => {
      writeWrapped(text, { breakBefore: true, flushPartial: true });
    },
    [writeWrapped]
  );

  const replayMessages = React.useCallback(
    (messagesToReplay: ChatMessage[]) => {
      for (const message of messagesToReplay) {
        printedMessagesRef.current.delete(message.id);
      }
      for (const message of messagesToReplay) {
        if (printedMessagesRef.current.has(message.id)) {
          continue;
        }
        const text = formatScrollbackMessage(message);
        printedMessagesRef.current.add(message.id);
        if (text !== null) {
          printRecord(text);
        }
      }
    },
    [printRecord]
  );

  React.useEffect(() => {
    for (const message of messages) {
      if (printedMessagesRef.current.has(message.id)) {
        continue;
      }
      const text = formatScrollbackMessage(message);
      printedMessagesRef.current.add(message.id);
      if (text !== null) {
        printRecord(text);
      }
    }
  }, [messages, printRecord]);

  const onOutputEvent = React.useCallback(
    (event: RuntimeOutputEvent) => {
      if (printedOutputEventsRef.current.has(event.eventId)) {
        return;
      }
      printedOutputEventsRef.current.add(event.eventId);
      const turnId =
        event.eventType === "assistant_turn_delta" || event.eventType === "assistant_turn_completed"
          ? event.payload.turnId
          : null;
      const turn =
        turnId === null
          ? { headingWritten: false, printedText: "" }
          : turnsRef.current.get(turnId) ?? { headingWritten: false, printedText: "" };
      const text = formatScrollbackOutputEvent(event, turn);
      if (turnId !== null) {
        turnsRef.current.set(turnId, turn);
      }
      if (text !== null) {
        if (turnId === null) {
          printRecord(text);
        } else {
          printStream(text);
        }
      }
    },
    [printRecord, printStream]
  );

  const onTraceEvent = React.useCallback(
    (event: TraceEvent) => {
      if (printedTraceEventsRef.current.has(event.eventId)) {
        return;
      }
      printedTraceEventsRef.current.add(event.eventId);
      const text = updateScrollbackToolState(toolsRef.current, event, { diffDisplay });
      if (text !== null) {
        printRecord(text);
      }
    },
    [diffDisplay, printRecord]
  );

  return {
    onOutputEvent,
    onTraceEvent,
    print,
    replayMessages
  };
}
