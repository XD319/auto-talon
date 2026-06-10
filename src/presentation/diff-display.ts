export type DiffDisplayMode = "collapsed" | "full" | "summary";

export const DEFAULT_DIFF_DISPLAY_MODE: DiffDisplayMode = "collapsed";

export const DIFF_COMMAND_MAX_LINES = 200;
export const DIFF_FULL_SCROLLBACK_MAX_LINES = 40;

export function resolveScrollbackPreviewMaxLines(mode: DiffDisplayMode): number {
  switch (mode) {
    case "summary":
      return 0;
    case "full":
      return DIFF_FULL_SCROLLBACK_MAX_LINES;
    default:
      return 15;
  }
}

export function resolveCommandDiffMaxLines(mode: DiffDisplayMode): number {
  switch (mode) {
    case "full":
      return DIFF_COMMAND_MAX_LINES;
    default:
      return 40;
  }
}
