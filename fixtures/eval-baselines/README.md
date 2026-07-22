# Approved Eval Baselines

This directory intentionally contains no synthetic baseline. Generate a report with a canonical real provider, review its failures and artifacts, then approve it with `talon eval baseline update`.

Recommended approval path for v0.1.0:

```bash
talon eval acceptance --provider xfyun-coding --repetitions 1 --json --output eval-artifacts/reliability-acceptance-xfyun
talon eval baseline update \
  --report eval-artifacts/reliability-acceptance-xfyun/eval-report.json \
  --output fixtures/eval-baselines/xfyun-coding-astron-code-latest.json
```

The nightly workflow also accepts `openai-gpt-4o-mini.json` when that provider is the approved gate. Absence is reported as an explicit baseline-comparison skip, not as a passing comparison.
