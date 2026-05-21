import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChatMessage } from "./view-models/chat-messages.js";

export interface PersistedChatSession {
  id: string;
  messages: ChatMessage[];
  sessionApprovalFingerprints?: string[];
  title?: string;
  threadId?: string;
  updatedAt: string;
}

export interface ChatSessionSummary {
  id: string;
  label: string;
  preview: string | null;
  threadId: string | null;
  updatedAt: string;
}

const UNTITLED_SESSION_LABEL = "Untitled conversation";

export function getSessionsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".auto-talon", "sessions");
}

export function getDraftsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".auto-talon", "drafts");
}

export async function ensureSessionsDir(workspaceRoot: string): Promise<string> {
  const dir = getSessionsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureDraftsDir(workspaceRoot: string): Promise<string> {
  const dir = getDraftsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveSession(workspaceRoot: string, session: PersistedChatSession): Promise<void> {
  const dir = await ensureSessionsDir(workspaceRoot);
  const path = join(dir, `${session.id}.json`);
  await writeFile(path, JSON.stringify(session, null, 2), "utf8");
}

export async function loadSession(workspaceRoot: string, sessionId: string): Promise<PersistedChatSession | null> {
  try {
    const raw = await readFile(join(getSessionsDir(workspaceRoot), `${sessionId}.json`), "utf8");
    const parsed = JSON.parse(raw) as PersistedChatSession;
    if (typeof parsed.id !== "string" || !Array.isArray(parsed.messages)) {
      return null;
    }
    if (
      parsed.sessionApprovalFingerprints !== undefined &&
      !Array.isArray(parsed.sessionApprovalFingerprints)
    ) {
      return null;
    }
    if (parsed.threadId !== undefined && typeof parsed.threadId !== "string") {
      return null;
    }
    if (parsed.title !== undefined && typeof parsed.title !== "string") {
      return null;
    }
    if (typeof parsed.updatedAt !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function listSessionIds(workspaceRoot: string): Promise<string[]> {
  try {
    const dir = getSessionsDir(workspaceRoot);
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/u, ""));
  } catch {
    return [];
  }
}

export async function listSessionSummaries(workspaceRoot: string): Promise<ChatSessionSummary[]> {
  const sessions = await Promise.all((await listSessionIds(workspaceRoot)).map((id) => loadSession(workspaceRoot, id)));
  return sessions
    .filter((session): session is PersistedChatSession => session !== null)
    .map((session) => summarizeSession(session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function summarizeSession(session: PersistedChatSession): ChatSessionSummary {
  const prompt = findRecentUserPrompt(session.messages);
  return {
    id: session.id,
    label: firstUsefulText([displaySessionTitle(session.title), prompt]) ?? UNTITLED_SESSION_LABEL,
    preview: prompt,
    threadId: session.threadId ?? null,
    updatedAt: session.updatedAt
  };
}

function displaySessionTitle(title: string | undefined): string | undefined {
  const normalized = title?.replace(/\s+/gu, " ").trim();
  if (normalized === undefined || normalized.length === 0 || normalized.toLowerCase() === "assistant") {
    return undefined;
  }
  return normalized;
}

function findRecentUserPrompt(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "user") {
      return summarizeText(message.text);
    }
  }
  return null;
}

function firstUsefulText(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";
    if (normalized.length > 0) {
      return summarizeText(normalized);
    }
  }
  return null;
}

function summarizeText(value: string, maxLength = 76): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}
