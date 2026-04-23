# Memory Troubleshooting

- Recall empty: verify memory status and scope key.
- Corruption suspicion: restore DB from `.auto-talon/rollbacks/`.
- Compaction issues: switch compact summarizer to deterministic and retry.
- Unexpected memory state: inspect with `talon memory list` and `talon memory show`.

Recovery helpers:

- `talon memory snapshot create ...`
- `talon workspace rollback <artifact_id>`
