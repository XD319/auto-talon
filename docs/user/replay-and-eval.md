# Replay and Eval

## Replay

```bash
talon replay <task_id>
talon replay <task_id> --provider mock --from-iteration 2
talon replay <task_id> --dry-run
```

## Eval

```bash
talon eval run
talon eval run --provider scripted-smoke --explain
talon eval smoke
talon eval beta
```

For auto-talon maintainer release verification, run `talon release check` from the repository root.
