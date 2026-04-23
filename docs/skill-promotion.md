# Skill Promotion

The auto-promotion flow turns repeated successful experiences into reviewable skill draft suggestions.

## Flow

1. `PromotionAdvisor` subscribes to `experience_reviewed` and `experience_promoted`.
2. It groups accepted/promoted experiences by normalized pattern key.
3. It computes promotion signals (`successRate`, `stability`, `riskLevel`, `humanJudgmentWeight`).
4. When thresholds pass, it generates a rich draft via `SkillDraftManager.createDraftFromAdvice`.
5. It records a version entry in `.auto-talon/skill-versions/*.jsonl`.
6. It emits `skill_promotion_suggested` trace and `skill_promoted` audit (pending outcome).
7. `InboxCollector` creates an action-required inbox item for manual review.

## Runtime Config

`runtime.config.json` now supports:

```json
{
  "promotion": {
    "enabled": true,
    "minSuccessCount": 3,
    "minSuccessRate": 0.8,
    "minStability": 0.6,
    "maxHumanJudgmentWeight": 0.4,
    "riskDenyKeywords": ["rm", "delete", "password", "secret", "drop table", "approval_required"]
  }
}
```

## Rollback

- Command: `talon skill rollback <skill-id> --reason "<text>"`
- Effect: removes the promoted skill directory and appends a `rollback` version entry.
- Audit: emits `skill_rolled_back`.

## Samples

- Trace: `fixtures/skill-promotion/promotion_suggested.sample.json`
- Audit (promoted): `fixtures/skill-promotion/audit_skill_promoted.sample.json`
- Audit (rollback): `fixtures/skill-promotion/audit_skill_rolled_back.sample.json`
