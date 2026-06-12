const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const GRAY = "\u001b[90m";
const CYAN = "\u001b[36m";

export function green(text: string): string {
  return `${GREEN}${text}${RESET}`;
}

export function red(text: string): string {
  return `${RED}${text}${RESET}`;
}

export function gray(text: string): string {
  return `${GRAY}${text}${RESET}`;
}

export function cyan(text: string): string {
  return `${CYAN}${text}${RESET}`;
}

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

export function reset(): string {
  return RESET;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape stripping intentionally matches ESC.
  return text.replace(/\u001b\[[0-9;]*m/gu, "");
}
