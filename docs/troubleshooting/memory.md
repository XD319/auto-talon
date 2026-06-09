# Memory Troubleshooting

- Recall empty: verify memory status and scope key.
- Corruption suspicion: restore DB from `.auto-talon/rollbacks/`.
- Compaction issues: check trace for `compact_summarizer_failed`; switch `compact.summarizer` to `deterministic` and retry.
- Context pressure: tune `compact.thresholdRatio`, `contextRetention.toolOutputMaxTokens`, or `compact.tailTokenBudget` (see `docs/dev/context-window.md`).
- Unexpected memory state: inspect with `talon memory list` and `talon memory show`.

Recovery helpers:

- `talon memory snapshot create ...`
- `talon workspace rollback <artifact_id>`
