import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, TRACE_EVENT_TYPES, type AuditLogRecord, type TraceEvent } from "../src/types/index.js";

describe("promotion fixtures", () => {
  it("validates skill promotion trace fixture", () => {
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures", "skill-promotion", "promotion_suggested.sample.json"), "utf8")
    ) as TraceEvent;
    expect(TRACE_EVENT_TYPES).toContain(fixture.eventType);
    expect(fixture.eventType).toBe("skill_promotion_suggested");
    const payload = fixture.payload as { draftId: string; targetSkillId: string; reasons: string[] };
    expect(payload.draftId.length).toBeGreaterThan(0);
    expect(payload.targetSkillId.startsWith("project:")).toBe(true);
    expect(payload.reasons.length).toBeGreaterThan(0);
  });

  it("validates skill promotion and rollback audit fixtures", () => {
    const promoted = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures", "skill-promotion", "audit_skill_promoted.sample.json"), "utf8")
    ) as AuditLogRecord;
    const rolledBack = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures", "skill-promotion", "audit_skill_rolled_back.sample.json"), "utf8")
    ) as AuditLogRecord;
    expect(AUDIT_ACTIONS).toContain(promoted.action);
    expect(AUDIT_ACTIONS).toContain(rolledBack.action);
    expect(promoted.action).toBe("skill_promoted");
    expect(rolledBack.action).toBe("skill_rolled_back");
  });
});
