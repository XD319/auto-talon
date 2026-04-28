export const SLASH_COMMANDS = [
  "/today",
  "/inbox",
  "/thread",
  "/thread new ",
  "/thread list",
  "/thread switch ",
  "/thread summary ",
  "/next",
  "/next list",
  "/next done ",
  "/next block ",
  "/commitments",
  "/commitments list",
  "/commitments done ",
  "/commitments block ",
  "/schedule",
  "/schedule list ",
  "/schedule create ",
  "/schedule pause ",
  "/schedule resume ",
  "/help",
  "/ops",
  "/status",
  "/clear",
  "/new",
  "/stop",
  "/history",
  "/context",
  "/memory",
  "/memory review",
  "/memory add ",
  "/memory forget ",
  "/memory why",
  "/cost",
  "/diff",
  "/sandbox",
  "/sessions",
  "/rollback ",
  "/title "
] as const;

export function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) {
    return "";
  }
  let prefix = strings[0] ?? "";
  for (const s of strings) {
    while (!s.startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export function completeSlashCommand(value: string): string | null {
  if (!value.startsWith("/")) {
    return null;
  }
  const hits = SLASH_COMMANDS.filter((command) => command.startsWith(value));
  if (hits.length === 0) {
    return null;
  }
  if (hits.length === 1) {
    const single = hits[0] ?? "";
    return single.endsWith(" ") ? single : `${single} `;
  }
  const common = longestCommonPrefix([...hits]);
  if (common.length > value.length) {
    return SLASH_COMMANDS.includes(common as (typeof SLASH_COMMANDS)[number]) ? `${common} ` : common;
  }
  const first = hits[0];
  return first !== undefined ? (first.endsWith(" ") ? first : `${first} `) : null;
}
