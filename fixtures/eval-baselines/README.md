# Approved Eval Baselines

This directory stores **reviewed** real-provider reports. Do not commit synthetic or mock results. Generate a report, inspect failures, then approve it with `talon eval baseline update`.

These files are **not interchangeable**. Comparing reports across suite ids, dataset hashes, or repetition counts requires `--allow-drift` and is not a comparable lock.

| File | Suite | Provider | What it is |
| --- | --- | --- | --- |
| `xfyun-coding-astron-code-latest.json` | `auto-talon-reliability-acceptance` v1 (20 tasks) | xfyun-coding / astron-code-latest, repetitions=1 | v0.1 acceptance gate from 2026-07-21 |
| `deepseek-blind-v2.json` | `internal-blind` v2 (35 tasks) | deepseek / deepseek-flash, repetitions=3 | Blind v2 Pass@1 lock from `eval-artifacts/blind-v2-relock3` (2026-09-24T15:25Z) |
| `deepseek-memory-v1.json` | `memory-compounding` v1 | deepseek / deepseek-flash, repetitions=3 | Memory four-arm lock |
| `deepseek-compaction-ab.json` | `long-context` v1 ON vs OFF | deepseek / deepseek-flash, repetitions=2 | Compaction A/B `comparison.json` |
| `deepseek-polyglot-python-ablation.json` | `aider-polyglot-python` 1.0.0 | deepseek / deepseek-flash, repetitions=2 | Public-suite governed vs ablated `comparison.json` (2026-09-25T07:40Z) |

`openai-gpt-4o-mini.json` is the optional nightly-workflow name; if it is absent, baseline comparison skips instead of passing.

## Historical acceptance path (xfyun, 20 tasks)

```bash
talon eval acceptance --provider xfyun-coding --repetitions 1 --json --output eval-artifacts/reliability-acceptance-xfyun
talon eval baseline update \
  --report eval-artifacts/reliability-acceptance-xfyun/eval-report.json \
  --output fixtures/eval-baselines/xfyun-coding-astron-code-latest.json
```

## DeepSeek lock path (35-task + memory)

See [docs/eval-results.md](../../docs/eval-results.md) and `scripts/run-locked-evals.ps1`. Concurrency must be 1. After the runs:

```bash
talon eval baseline update \
  --report eval-artifacts/blind-v2-relock3/eval-report.json \
  --output fixtures/eval-baselines/deepseek-blind-v2.json \
  --min-success-rate 0
talon eval baseline update \
  --report eval-artifacts/memory-relock/eval-report.json \
  --output fixtures/eval-baselines/deepseek-memory-v1.json \
  --min-success-rate 0
```
