# Replay and Eval

## Replay

```bash
agent replay <task_id>
agent replay <task_id> --provider mock --from-iteration 2
agent replay <task_id> --dry-run
```

## Eval

```bash
agent eval run
agent eval run --provider scripted-smoke --explain
agent eval smoke
agent eval beta
```

For release verification, use `agent release check`.
