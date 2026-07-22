# Memory Troubleshooting

- Recall empty: verify memory status and scope key; run `talon memory doctor` and check `ftsCoverage`.
- Chinese recall weak: ensure memories were written after CJK keyword support; re-add or accept suggestions again.
- Agent suggestion accepted but missing: confirm inbox metadata uses `memorySuggestionDraft` (legacy `draft` is still accepted).
- Corruption suspicion: restore DB from `.auto-talon/rollbacks/`.
- Compaction issues: check trace for `compact_summarizer_failed`; switch `compact.summarizer` to `deterministic` and retry.
- Context pressure: tune `compact.thresholdRatio`, `contextRetention.toolOutputMaxTokens`, or `compact.tailTokenBudget` (see `docs/dev/context-window.md`).
- Unexpected memory state: inspect with `talon memory list` and `talon memory show`.
- Embedding search unused: default provider is local FTS5; set `memory.search.provider` to `openai_compatible` and provide the API key env only if you want vectors.

Recovery helpers:

- `talon memory snapshot create ...`
- `talon workspace rollback <artifact_id>`
- `talon memory maintenance rebuild --dry-run`
