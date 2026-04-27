import type { CommitmentRecord } from "../../types/index.js";
import type { CommitmentService } from "./commitment-service.js";
import type { NextActionService } from "./next-action-service.js";

export interface AssistantProjectionInput {
  output: string;
  taskId: string;
  threadId: string;
}

interface ParsedProjection {
  blockedItems: ParsedItem[];
  commitments: ParsedItem[];
  nextActions: ParsedItem[];
}

interface ParsedItem {
  blocked: boolean;
  reason: string | null;
  title: string;
}

export interface AssistantThreadProjectionServiceDependencies {
  commitmentService: CommitmentService;
  nextActionService: NextActionService;
}

const COMMITMENT_OPEN_STATUSES: CommitmentRecord["status"][] = ["open", "in_progress", "blocked", "waiting_decision"];
const HEADING_COMMITMENTS = /^(commitments?|承诺|承諾|责任|責任)\s*[:：]?$/iu;
const HEADING_NEXT = /^(next(\s+actions?)?|next\s*steps?|下一步|后续行动|後續行動)\s*[:：]?$/iu;
const HEADING_BLOCKED = /^(blocked|阻塞|受阻|卡住|blocked\s+items?)\s*[:：]?$/iu;

export class AssistantThreadProjectionService {
  public constructor(private readonly dependencies: AssistantThreadProjectionServiceDependencies) {}

  public project(input: AssistantProjectionInput): void {
    const parsed = parseAssistantOutput(input.output);
    if (parsed.commitments.length === 0 && parsed.nextActions.length === 0 && parsed.blockedItems.length === 0) {
      return;
    }
    const openCommitments = this.dependencies.commitmentService.list({
      statuses: COMMITMENT_OPEN_STATUSES,
      threadId: input.threadId
    });
    const commitmentByTitle = new Map(openCommitments.map((item) => [normalizeTitle(item.title), item] as const));
    let openCommitmentForBlocked = openCommitments[0] ?? null;

    for (const item of parsed.commitments) {
      const normalized = normalizeTitle(item.title);
      const existing = commitmentByTitle.get(normalized) ?? null;
      const commitment =
        existing ??
        this.dependencies.commitmentService.create({
          ownerUserId: inferOwnerUserId(openCommitments),
          source: "assistant_pledge",
          sourceTraceId: input.taskId,
          status: "open",
          summary: item.title,
          taskId: input.taskId,
          threadId: input.threadId,
          title: item.title
        });
      if (existing === null) {
        commitmentByTitle.set(normalized, commitment);
      } else if (existing.sourceTraceId !== input.taskId || existing.taskId !== input.taskId) {
        this.dependencies.commitmentService.update(existing.commitmentId, {
          sourceTraceId: input.taskId,
          taskId: input.taskId
        });
      }
      if (item.blocked && item.reason !== null) {
        this.dependencies.commitmentService.block(commitment.commitmentId, item.reason);
      }
      if (openCommitmentForBlocked === null) {
        openCommitmentForBlocked = commitment;
      }
    }

    const openNextActions = this.dependencies.nextActionService.list({
      statuses: ["active", "pending", "blocked"],
      threadId: input.threadId
    });
    const nextActionByTitle = new Map(openNextActions.map((item) => [normalizeTitle(item.title), item] as const));

    let assignedActive = false;
    for (const item of parsed.nextActions) {
      const normalized = normalizeTitle(item.title);
      const existing = nextActionByTitle.get(normalized) ?? null;
      const nextStatus = item.blocked ? "blocked" : assignedActive ? "pending" : "active";
      if (!item.blocked && !assignedActive) {
        assignedActive = true;
      }
      const blockedReason = item.blocked ? item.reason ?? "blocked" : null;
      if (existing === null) {
        const created = this.dependencies.nextActionService.create({
          blockedReason: null,
          commitmentId: openCommitmentForBlocked?.commitmentId ?? null,
          detail: item.reason,
          source: "assistant_pledge",
          sourceTraceId: input.taskId,
          status: item.blocked ? "pending" : nextStatus,
          taskId: input.taskId,
          threadId: input.threadId,
          title: item.title
        });
        if (item.blocked) {
          this.dependencies.nextActionService.block(created.nextActionId, blockedReason ?? "blocked");
        }
        nextActionByTitle.set(normalized, created);
      } else {
        if (item.blocked) {
          this.dependencies.nextActionService.update(existing.nextActionId, {
            detail: item.reason,
            sourceTraceId: input.taskId,
            taskId: input.taskId
          });
          this.dependencies.nextActionService.block(existing.nextActionId, blockedReason ?? "blocked");
        } else {
          this.dependencies.nextActionService.update(existing.nextActionId, {
            blockedReason: null,
            detail: item.reason,
            sourceTraceId: input.taskId,
            status: nextStatus,
            taskId: input.taskId
          });
        }
      }
    }

    for (const item of parsed.blockedItems) {
      const normalized = normalizeTitle(item.title);
      const existing = nextActionByTitle.get(normalized) ?? null;
      if (existing === null) {
        const created = this.dependencies.nextActionService.create({
          blockedReason: null,
          commitmentId: openCommitmentForBlocked?.commitmentId ?? null,
          detail: item.reason,
          source: "assistant_pledge",
          sourceTraceId: input.taskId,
          status: "pending",
          taskId: input.taskId,
          threadId: input.threadId,
          title: item.title
        });
        this.dependencies.nextActionService.block(created.nextActionId, item.reason ?? "blocked");
      } else {
        this.dependencies.nextActionService.block(existing.nextActionId, item.reason ?? "blocked");
      }
    }
  }
}

function parseAssistantOutput(output: string): ParsedProjection {
  const lines = output.split(/\r?\n/gu).map((line) => line.trim()).filter((line) => line.length > 0);
  const parsed: ParsedProjection = { blockedItems: [], commitments: [], nextActions: [] };
  let section: "commitments" | "nextActions" | "blockedItems" | null = null;
  let structuredFound = false;
  for (const line of lines) {
    if (HEADING_COMMITMENTS.test(stripMarkdownPunctuation(line))) {
      section = "commitments";
      structuredFound = true;
      continue;
    }
    if (HEADING_NEXT.test(stripMarkdownPunctuation(line))) {
      section = "nextActions";
      structuredFound = true;
      continue;
    }
    if (HEADING_BLOCKED.test(stripMarkdownPunctuation(line))) {
      section = "blockedItems";
      structuredFound = true;
      continue;
    }
    const listItem = parseListItem(line);
    if (listItem === null) {
      continue;
    }
    if (section !== null) {
      parsed[section].push(listItem);
      continue;
    }
    const keyed = parseKeyedLine(line);
    if (keyed !== null) {
      parsed[keyed.section].push(keyed.item);
      structuredFound = true;
    }
  }
  if (structuredFound || lines.length === 0) {
    return parsed;
  }
  for (const line of lines) {
    const listItem = parseListItem(line);
    if (listItem === null) {
      continue;
    }
    if (listItem.blocked) {
      parsed.blockedItems.push(listItem);
    } else {
      parsed.nextActions.push(listItem);
    }
  }
  return parsed;
}

function parseKeyedLine(line: string): { item: ParsedItem; section: keyof ParsedProjection } | null {
  const [rawKey, ...rest] = line.split(/[:：]/u);
  if (rest.length === 0 || rawKey === undefined) {
    return null;
  }
  const key = rawKey.trim().toLowerCase();
  const value = rest.join(":").trim();
  if (value.length === 0) {
    return null;
  }
  const item = toParsedItem(value);
  if (key === "commitment" || key === "commitments" || key === "承诺" || key === "承諾") {
    return { item, section: "commitments" };
  }
  if (key === "next" || key === "next action" || key === "next actions" || key === "下一步") {
    return { item, section: "nextActions" };
  }
  if (key === "blocked" || key === "阻塞" || key === "受阻") {
    return { item: { ...item, blocked: true }, section: "blockedItems" };
  }
  return null;
}

function parseListItem(line: string): ParsedItem | null {
  const cleaned = line.replace(/^[-*]\s+/u, "").replace(/^\d+[.)]\s+/u, "").trim();
  if (cleaned.length === 0) {
    return null;
  }
  if (cleaned.startsWith("[ ] ") || cleaned.startsWith("[x] ") || cleaned.startsWith("[X] ")) {
    return toParsedItem(cleaned.slice(4));
  }
  if (cleaned === line && !/^[-*]|\d+[.)]/u.test(line.trim())) {
    return null;
  }
  return toParsedItem(cleaned);
}

function toParsedItem(raw: string): ParsedItem {
  const value = stripMarkdownPunctuation(raw).trim();
  const blockedMatch = value.match(/(?:^|\b)(blocked|阻塞|受阻|卡住)\s*[:：-]?\s*(.+)$/iu);
  if (blockedMatch !== null) {
    const reason = blockedMatch[2]?.trim() ?? value;
    return {
      blocked: true,
      reason,
      title: reason
    };
  }
  const parts = value.split(/\s[-—–]\s/gu);
  if (parts.length >= 2) {
    const [title, ...detail] = parts;
    return {
      blocked: false,
      reason: detail.join(" - ").trim() || null,
      title: title?.trim() ?? value
    };
  }
  return { blocked: false, reason: null, title: value };
}

function stripMarkdownPunctuation(value: string): string {
  return value.replace(/^#+\s*/u, "").replace(/^\*\*|\*\*$/gu, "").trim();
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function inferOwnerUserId(commitments: CommitmentRecord[]): string {
  return commitments[0]?.ownerUserId ?? process.env.USERNAME ?? process.env.USER ?? "local-user";
}
