import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  ApprovalRulesConfig,
  PersistedApprovalRule
} from "../types/index.js";

const DEFAULT_CONFIG: ApprovalRulesConfig = {
  version: 1,
  rules: []
};

export class ApprovalRuleStore {
  private readonly path: string;

  public constructor(workspaceRoot: string) {
    this.path = join(workspaceRoot, ".auto-talon", "approval-rules.json");
  }

  public read(): ApprovalRulesConfig {
    if (!existsSync(this.path)) {
      return DEFAULT_CONFIG;
    }
    const raw = readFileSync(this.path, "utf8").trim();
    if (raw.length === 0) {
      return DEFAULT_CONFIG;
    }
    const parsed = JSON.parse(raw) as Partial<ApprovalRulesConfig>;
    return {
      version: 1,
      rules: Array.isArray(parsed.rules) ? parsed.rules : []
    };
  }

  public list(): PersistedApprovalRule[] {
    return this.read().rules;
  }

  public hasFingerprint(fingerprint: string): boolean {
    return this.list().some((rule) => rule.fingerprint === fingerprint);
  }

  public add(rule: PersistedApprovalRule): void {
    const config = this.read();
    if (config.rules.some((item) => item.fingerprint === rule.fingerprint)) {
      return;
    }
    config.rules.push(rule);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }
}
