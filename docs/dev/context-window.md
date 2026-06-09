# Context Window Management

auto-talon manages long sessions with a two-tier context pipeline inspired by Codex, Claude Code, and Hermes Agent.

## Tiers

1. **Micro-compaction (every provider call)** — prunes old tool results (keeps the latest 5) and enforces per-result tool output budgets with artifact spill.
2. **Macro-compaction (headroom threshold)** — summarizes the middle of the conversation into a decision-oriented handoff packet, preserves a token-budget tail, and rehydrates pinned recent files.

## Token accounting

Hybrid counting combines the last provider `inputTokens` with a conservative char/4 × 1.33 estimate for messages added since that API call.

Macro-compaction triggers when estimated prompt tokens reach:

```
(inputLimit - reservedOutput) * thresholdRatio - bufferTokens
```

## Configuration (`.auto-talon/runtime.config.json`)

```json
{
  "compact": {
    "thresholdRatio": 0.8,
    "bufferTokens": 8000,
    "tailTokenBudget": 20000,
    "tailMinMessages": 10,
    "messageThreshold": 100,
    "iterationThreshold": 24,
    "toolCallThreshold": 40,
    "summarizer": "provider_subagent"
  },
  "contextRetention": {
    "maxFiles": 8,
    "maxBytesPerFile": 24000,
    "maxTotalBytes": 128000,
    "maxTotalBytesUnderGuard": 200000,
    "toolOutputMaxTokens": 2500
  }
}
```

## Summarizer modes

- `deterministic` — rule-based structured summary (no provider call).
- `provider_subagent` — LLM handoff summary via `routing.helpers.summarize`. Failures are traced and surfaced; switch to `deterministic` if the helper provider is unavailable.

## Artifacts

Oversized tool outputs spill to `.auto-talon/artifacts/<taskId>/<toolCallId>.txt`. The model receives a preview plus the recovery path.

## Comparison

| Feature | Codex | Claude Code | Hermes | auto-talon |
|---------|-------|-------------|--------|------------|
| Tool output cap | token + spill | clear old results | prune before summarize | token + spill |
| Compact trigger | context pressure | ~95% headroom | 50% tokens | thresholdRatio |
| Tail protection | N/A | recent files | token tail | token tail + pinned files |
| Summary style | truncate-first | structured sections | handoff packet | decision-oriented handoff |
