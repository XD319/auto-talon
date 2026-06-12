export const TOOLSET_NAMES = [
  "automation",
  "file",
  "shell",
  "web",
  "interaction",
  "skills",
  "session",
  "agent",
  "mcp"
] as const;

export type ToolsetName = (typeof TOOLSET_NAMES)[number];
