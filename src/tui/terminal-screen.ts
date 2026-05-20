export interface TerminalScreenLease {
  release: () => void;
}

const ENTER_ALT_SCREEN = "\u001b[?1049h\u001b[2J\u001b[H";
const EXIT_ALT_SCREEN = "\u001b[?1049l";

export function enterTerminalScreen(stdout: NodeJS.WriteStream = process.stdout): TerminalScreenLease {
  if (stdout.isTTY !== true) {
    return { release: () => undefined };
  }

  stdout.write(ENTER_ALT_SCREEN);
  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      stdout.write(EXIT_ALT_SCREEN);
    }
  };
}
