# Replay and Eval

## Replay

```bash
talon replay <task_id>
talon replay <task_id> --provider mock --from-iteration 2
talon replay <task_id> --dry-run
```

## Eval

Eval and smoke commands are maintainer diagnostics for source checkouts. They
use fixture files from the repository, or a custom file passed with
`--fixture`.

```bash
talon eval run --fixture fixtures/runtime-smoke-tasks.json
talon eval run --provider scripted-smoke --explain
talon smoke run --fixture fixtures/runtime-smoke-tasks.json
talon eval beta
```

For auto-talon maintainer release verification, run `talon release check` from the repository root.
