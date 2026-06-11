import { bold, cyan, gray, green } from "./ansi.js";
import { sanitizeTerminalText } from "./text-sanitize.js";

const USER_GLYPH = "› ";

export function formatUserScrollbackLine(text: string, options?: { leadingBreak?: boolean }): string {
  const breakPrefix = options?.leadingBreak === true ? "\n" : "";
  return `${breakPrefix}${green(bold(USER_GLYPH))}${sanitizeTerminalText(text)}\n`;
}

export function formatAssistantScrollbackHeading(options?: { leadingBreak?: boolean }): string {
  const breakPrefix = options?.leadingBreak === true ? "\n" : "";
  return `${breakPrefix}${cyan(bold("● AutoTalon"))}\n`;
}

export function formatAssistantScrollbackBody(text: string): string {
  return `${sanitizeTerminalText(text)}\n`;
}

export function formatSystemScrollbackLine(text: string): string {
  return `${gray("┊")} ${gray(sanitizeTerminalText(text))}\n`;
}

export const transcriptRoleLabels = {
  assistant: "● AutoTalon",
  input: USER_GLYPH.trim(),
  status: "┊"
} as const;
