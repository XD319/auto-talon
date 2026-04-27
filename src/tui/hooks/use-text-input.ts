import React from "react";
import { useInput } from "ink";

import { readClipboardText } from "../clipboard.js";

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export interface UseTextInputOptions {
  onHistoryNext: () => string | null;
  onHistoryPrevious: () => string | null;
  onImagePasteAttempt?: () => void;
  onInterruptRequest: () => void;
  busy: boolean;
  hasPendingApproval: boolean;
  onApprovalAction: (action: "allow" | "deny") => void;
  onExit: () => void;
  onSubmit: (text: string) => boolean | Promise<boolean>;
  onSubmitBlockedBusy?: () => void;
  /** Return replacement value, or null to leave input unchanged. */
  onTabComplete?: (value: string) => string | null;
}

export interface TextInputController {
  cursorIndex: number;
  lines: string[];
  value: string;
}

export function resolveApprovalShortcut(
  input: string,
  value: string,
  hasPendingApproval: boolean
): "allow" | "deny" | null {
  if (!hasPendingApproval || value.trim().length !== 0) {
    return null;
  }
  const loweredInput = input.toLowerCase();
  if (loweredInput === "a") {
    return "allow";
  }
  if (loweredInput === "d") {
    return "deny";
  }
  return null;
}

export function canSubmitTextInput(value: string, busy: boolean): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return !busy || trimmed === "/stop";
}

export function useTextInput(options: UseTextInputOptions): TextInputController {
  const [value, setValue] = React.useState("");
  const [cursorIndex, setCursorIndex] = React.useState(0);
  const preferredColumnRef = React.useRef<number | null>(null);
  const interruptRequestedAtRef = React.useRef<number | null>(null);
  const cursorIndexRef = React.useRef(0);

  React.useEffect(() => {
    cursorIndexRef.current = cursorIndex;
  }, [cursorIndex]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const now = Date.now();
      const lastRequestedAt = interruptRequestedAtRef.current;
      if (lastRequestedAt !== null && now - lastRequestedAt <= 2_000) {
        options.onExit();
        return;
      }

      interruptRequestedAtRef.current = now;
      options.onInterruptRequest();
      return;
    }

    if (key.tab) {
      if (options.onTabComplete !== undefined) {
        const completed = options.onTabComplete(value);
        if (completed !== null) {
          setValue(completed);
          setCursorIndex(completed.length);
          preferredColumnRef.current = null;
        }
      }
      return;
    }

    if (key.pageUp || key.pageDown) {
      return;
    }

    if (key.ctrl && key.shift && input === "v") {
      void readClipboardText()
        .then((text) => {
          const clip = normalizeNewlines(text);
          const insertionIndex = cursorIndexRef.current;
          setValue((current) => insertAt(current, insertionIndex, clip));
          setCursorIndex(insertionIndex + clip.length);
          preferredColumnRef.current = null;
        })
        .catch(() => {});
      return;
    }

    const keyAlt = key as { alt?: boolean };
    if (keyAlt.alt === true && input === "v" && options.onImagePasteAttempt !== undefined) {
      options.onImagePasteAttempt();
      return;
    }

    if (key.ctrl && input === "j") {
      setValue((current) => insertAt(current, cursorIndex, "\n"));
      setCursorIndex((current) => current + 1);
      preferredColumnRef.current = null;
      return;
    }

    if (key.ctrl && input === "p") {
      const previous = options.onHistoryPrevious();
      if (previous !== null) {
        setValue(previous);
        setCursorIndex(previous.length);
        preferredColumnRef.current = null;
      }
      return;
    }

    if (key.ctrl && input === "n") {
      const next = options.onHistoryNext();
      if (next !== null) {
        setValue(next);
        setCursorIndex(next.length);
        preferredColumnRef.current = null;
      }
      return;
    }

    const approvalAction =
      key.ctrl || key.meta || keyAlt.alt === true
        ? null
        : resolveApprovalShortcut(input, value, options.hasPendingApproval);
    if (approvalAction !== null) {
      options.onApprovalAction(approvalAction);
      return;
    }

    if (key.leftArrow) {
      setCursorIndex((current) => getPreviousGraphemeIndex(value, current));
      preferredColumnRef.current = null;
      return;
    }

    if (key.rightArrow) {
      setCursorIndex((current) => getNextGraphemeIndex(value, current));
      preferredColumnRef.current = null;
      return;
    }

    if (key.upArrow) {
      const next = moveCursorVertical(value, cursorIndex, -1, preferredColumnRef.current);
      setCursorIndex(next.index);
      preferredColumnRef.current = next.preferredColumn;
      return;
    }

    if (key.downArrow) {
      const next = moveCursorVertical(value, cursorIndex, 1, preferredColumnRef.current);
      setCursorIndex(next.index);
      preferredColumnRef.current = next.preferredColumn;
      return;
    }

    const navKey = key as { end?: boolean; home?: boolean };
    if (navKey.home === true) {
      setCursorIndex(getLineStartIndex(value, cursorIndex));
      preferredColumnRef.current = null;
      return;
    }

    if (navKey.end === true) {
      setCursorIndex(getLineEndIndex(value, cursorIndex));
      preferredColumnRef.current = null;
      return;
    }

    if (key.return) {
      if (key.meta) {
        setValue((current) => insertAt(current, cursorIndex, "\n"));
        setCursorIndex((current) => current + 1);
        preferredColumnRef.current = null;
      } else {
        const hasInput = value.trim().length > 0;
        if (canSubmitTextInput(value, options.busy)) {
          void Promise.resolve(options.onSubmit(value))
            .then((accepted) => {
              if (accepted === false) {
                options.onSubmitBlockedBusy?.();
                return;
              }
              setValue("");
              setCursorIndex(0);
              preferredColumnRef.current = null;
            })
            .catch(() => {});
        } else if (hasInput && options.busy) {
          options.onSubmitBlockedBusy?.();
        }
      }
      return;
    }

    if (key.ctrl && input === "u") {
      setValue("");
      setCursorIndex(0);
      preferredColumnRef.current = null;
      return;
    }

    if (key.ctrl && input === "a") {
      setCursorIndex(0);
      preferredColumnRef.current = null;
      return;
    }

    if (key.ctrl && input === "e") {
      setCursorIndex(value.length);
      preferredColumnRef.current = null;
      return;
    }

    if (key.ctrl && input === "w") {
      const next = deletePreviousWord(value, cursorIndex);
      if (next.value !== value || next.cursorIndex !== cursorIndex) {
        setValue(next.value);
        setCursorIndex(next.cursorIndex);
        preferredColumnRef.current = null;
      }
      return;
    }

    if (key.backspace) {
      if (cursorIndex === 0) {
        return;
      }
      const next = deleteCharacterBefore(value, cursorIndex);
      setValue(next.value);
      setCursorIndex(next.cursorIndex);
      preferredColumnRef.current = null;
      return;
    }

    if (key.delete) {
      const next = deleteCharacterAfter(value, cursorIndex);
      setValue(next.value);
      setCursorIndex(next.cursorIndex);
      preferredColumnRef.current = null;
      return;
    }

    if (key.ctrl || (key.meta && input.length === 0)) {
      return;
    }

    setValue((current) => insertAt(current, cursorIndex, input));
    setCursorIndex((current) => current + input.length);
    preferredColumnRef.current = null;
  });

  return {
    cursorIndex,
    lines: buildLinesWithCursor(value, cursorIndex),
    value
  };
}

function insertAt(value: string, index: number, fragment: string): string {
  return `${value.slice(0, index)}${fragment}${value.slice(index)}`;
}

export function deleteCharacterBefore(
  value: string,
  cursorIndex: number
): { value: string; cursorIndex: number } {
  if (cursorIndex <= 0) {
    return { cursorIndex: 0, value };
  }
  const deleteStart = getPreviousGraphemeIndex(value, cursorIndex);

  return {
    cursorIndex: deleteStart,
    value: `${value.slice(0, deleteStart)}${value.slice(cursorIndex)}`
  };
}

export function deleteCharacterAfter(
  value: string,
  cursorIndex: number
): { value: string; cursorIndex: number } {
  if (cursorIndex >= value.length) {
    return { cursorIndex, value };
  }
  const deleteEnd = getNextGraphemeIndex(value, cursorIndex);

  return {
    cursorIndex,
    value: `${value.slice(0, cursorIndex)}${value.slice(deleteEnd)}`
  };
}

function buildLinesWithCursor(value: string, cursorIndex: number): string[] {
  const cursorGlyph = "|";
  const withCursor = `${value.slice(0, cursorIndex)}${cursorGlyph}${value.slice(cursorIndex)}`;
  return withCursor.split("\n");
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function getPreviousGraphemeIndex(value: string, cursorIndex: number): number {
  if (cursorIndex <= 0) {
    return 0;
  }
  const bounded = Math.min(cursorIndex, value.length);
  if (graphemeSegmenter === null) {
    return bounded - 1;
  }
  let previous = 0;
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index >= bounded) {
      break;
    }
    previous = segment.index;
  }
  return previous;
}

function getNextGraphemeIndex(value: string, cursorIndex: number): number {
  const bounded = Math.max(0, Math.min(cursorIndex, value.length));
  if (bounded >= value.length) {
    return value.length;
  }
  if (graphemeSegmenter === null) {
    return bounded + 1;
  }
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index <= bounded) {
      continue;
    }
    return segment.index;
  }
  return value.length;
}

export function moveCursorVertical(
  value: string,
  cursorIndex: number,
  direction: -1 | 1,
  preferredColumn: number | null
): { index: number; preferredColumn: number } {
  const lines = value.split("\n");
  const position = getCursorPosition(value, cursorIndex);
  const nextLine = position.line + direction;

  if (nextLine < 0 || nextLine >= lines.length) {
    return {
      index: cursorIndex,
      preferredColumn: preferredColumn ?? position.column
    };
  }

  const targetColumn = preferredColumn ?? position.column;
  const boundedColumn = Math.min(targetColumn, lines[nextLine]?.length ?? 0);
  const nextIndex = getCursorIndexFromLineColumn(lines, nextLine, boundedColumn);

  return {
    index: nextIndex,
    preferredColumn: targetColumn
  };
}

function getCursorPosition(value: string, cursorIndex: number): { line: number; column: number } {
  const lines = value.split("\n");
  let offset = 0;

  for (let line = 0; line < lines.length; line += 1) {
    const lineLength = lines[line]?.length ?? 0;
    const lineEnd = offset + lineLength;
    if (cursorIndex <= lineEnd) {
      return {
        column: cursorIndex - offset,
        line
      };
    }
    offset = lineEnd + 1;
  }

  const lastLine = Math.max(0, lines.length - 1);
  return {
    column: lines[lastLine]?.length ?? 0,
    line: lastLine
  };
}

function getCursorIndexFromLineColumn(lines: string[], line: number, column: number): number {
  let index = 0;
  for (let i = 0; i < line; i += 1) {
    index += (lines[i]?.length ?? 0) + 1;
  }
  return index + column;
}

function getLineStartIndex(value: string, cursorIndex: number): number {
  const lastBreak = value.lastIndexOf("\n", Math.max(0, cursorIndex - 1));
  return lastBreak === -1 ? 0 : lastBreak + 1;
}

function getLineEndIndex(value: string, cursorIndex: number): number {
  const nextBreak = value.indexOf("\n", cursorIndex);
  return nextBreak === -1 ? value.length : nextBreak;
}

export function deletePreviousWord(
  value: string,
  cursorIndex: number
): { value: string; cursorIndex: number } {
  if (cursorIndex <= 0) {
    return { cursorIndex: 0, value };
  }

  let index = cursorIndex;
  while (index > 0 && /\s/u.test(value[index - 1] ?? "")) {
    index -= 1;
  }
  while (index > 0 && !/\s/u.test(value[index - 1] ?? "")) {
    index -= 1;
  }

  return {
    cursorIndex: index,
    value: `${value.slice(0, index)}${value.slice(cursorIndex)}`
  };
}
