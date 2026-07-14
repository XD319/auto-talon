# Approved Eval Baselines

This directory intentionally contains no synthetic baseline. Generate a report with the canonical real provider, review its failures and artifacts, then approve it with `talon eval baseline update`.

The nightly workflow expects `openai-gpt-4o-mini.json`. Absence is reported as an explicit baseline-comparison skip, not as a passing comparison.
