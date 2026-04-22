# Memory Troubleshooting

- Recall empty: verify memory status and scope key.
- Corruption suspicion: restore DB from `.auto-talon/rollbacks/`.
- Compaction issues: switch compact summarizer to deterministic and retry.
- Unexpected memory state: inspect with `agent memory list` and `agent memory show`.

Recovery helpers:

- `agent memory snapshot create ...`
- `agent workspace rollback <artifact_id>`
