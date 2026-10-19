# Eval results

This file records AutoTalon's locked capability evals. Numbers below come from archived DeepSeek lock runs on 2026-09-24 (memory, compaction, and the current blind v2 relock) and the 2026-09-25 polyglot ablation. Cite these artifacts; do not mix in the historical xfyun 20-task acceptance gate.

## Caliber (locked protocol)

| Field | Value |
| --- | --- |
| Provider | `deepseek` (custom OpenAI-compatible) |
| Model | `deepseek-flash` |
| Base URL | `https://api.deepseek.com` |
| Context window | `1000000` (explicit; do not rely on the 32000 fallback) |
| `defaultMaxIterations` | `12` (product default; not raised for eval; confirmed on trial records) |
| Repetitions | `3` for blind v2 and memory; `2` for compaction A/B |
| Concurrency | `1` (required for P50/P95) |
| Code SHA | `bd0336c4e89fb38cbba5b8afd5df647f671515cb` |
| Pricing used for `costUsd` / `--max-cost-usd` | peak-rate conservative: input `$0.30` / cached input `$0.006` / output `$1.20` per 1M tokens ([DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)) |
| Credential | plaintext `apiKey` in gitignored `.auto-talon/provider.config.json` (DeepSeek `provider test` succeeded) |
| Cost reporting | **unavailable** on the capability reports (`metrics.costUsd.available = false`). Do not quote a dollar cost. Cached-input tokens were recorded. |

Run the three locking jobs with `./scripts/run-locked-evals.ps1` after `npm run build`. Interrupted jobs resume with `talon eval run --resume eval-artifacts/<dir>`. Memory four-arm relock finished on 2026-09-24 (`eval-artifacts/memory-relock`). Compaction A/B relock finished the same day (`eval-artifacts/compaction-ab-relock2`); the earlier `compaction-ab-relock` attempt died on `Insufficient Balance` and must not be quoted. Blind v2 **relock3** finished 2026-09-24T15:25Z after the tool-schema and `schedule_created` attribution fixes (`eval-artifacts/blind-v2-relock3`). Relock2 (96.2%) and the 2026-09-19 locks are superseded.

## How to read the locked results

### 1. Long-context governance (compaction A/B)

Source: `fixtures/eval-baselines/deepseek-compaction-ab.json` from `eval-artifacts/compaction-ab-relock2/comparison.json` against `fixtures/eval-suites/long-context.v1.json`. Dataset SHA `9632487f7d68b6e1bd3b6f8ad5a927578657360e37c6334e65c6ac068e5589f0`. Generated `2026-09-24T08:56:53.233Z`. 8 tasks × 2 arms × 2 reps. Both arm gates **passed**. Adapter 400s: **0**. `Insufficient Balance`: 0.

Compaction is forced by the harness (`deterministic` summarizer, `minTokenPressureRatio: 0`). This measures whether forced compaction preserves score, **not** whether the default 50% pressure gate would fire on a 5–7KB workspace.

The 2026-09-19 `compaction-ab-locked` run (ON 81.3% vs OFF 100%) is superseded: those 3 ON failures were `reasoning_content` 400s. The 2026-09-24 `compaction-ab-relock` attempt died on `Insufficient Balance` and must not be quoted.

| Arm | Trial success | Pass@k | Input tokens | Total tokens | Cache hit rate | `session_compacted` | Rounds / tools | P50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ON (forced compact) | **100%** (16/16) | 100% | 1,668,392 | 1,701,729 | 33.1% | **69** | 9.69 / 11.31 | 13.6s |
| OFF (thresholds disabled) | **100%** (16/16) | 100% | 931,618 | 963,560 | 59.7% | **0** | 9.50 / 10.69 | 13.5s |
| ON − OFF | **0pp** | 0pp | **+736,774** | +738,169 | −26.6pp | +69 | — | — |

Quality held. Forced compaction on this suite **increased** input tokens by 79% and cut cache hit rate. Do not report a token-savings number for this suite. Describe compaction by its mechanism and this cache result.

### 2. Structured memory (four arms)

Source: `fixtures/eval-baselines/deepseek-memory-v1.json` from `eval-artifacts/memory-relock/eval-report.json`. Suite `auto-talon-memory-compounding@1.0.0`. Dataset SHA `6dac2895f8d4b4bc105de77742c153b8204caf0f065d269977ad91ccc036983f`. Generated `2026-09-24T08:42:41.443Z`. Gate **passed**. Adapter 400s: **0/96**. `Insufficient Balance`: 0.

The 2026-09-19 `memory-locked` run (61.5% Pass@1, 19 protocol 400s) is superseded; do not quote it.

| Metric | Value |
| --- | --- |
| Task-arm combos / scorable trials | 32 / 96 |
| Trial success (Pass@1) | **85.4%** (95% Wilson CI **77.0%–91.1%**) |
| Pass@k / pass^k (k=3) | 93.8% / 80.3% |
| Duration P50 / P95 | 11.9s / 26.5s |
| Average rounds / tool calls | 7.41 / 8.34 |
| Iteration cap hits | 13 / 96 (**13.5%**) |
| Tokens (input / cached input / total) | 3,849,298 / 2,642,944 / 4,014,517 |
| Cold→warm relative reduction (rounds) | **9.2%** (bootstrap mean; interval **0.2% to 19.1%**) |
| Cold→warm relative reduction (tool calls) | **19.7%** (**2.2% to 38.0%**) |
| Cold→warm relative reduction (duration) | **8.7%** (0.02% to 18.1%) |
| Cold→warm relative reduction (input tokens) | **5.8%** (−5.7% to 17.3%, **crosses zero**) |
| recall@k | **62.5%** |
| poison-following | **20.8%** |
| Workspace scope violations | 4.2% (4/96) |
| Harness errors | 0.0% |

Paired reductions are `(cold − warm) / cold` per task, then a bootstrap mean across 8 task pairs. Rounds, tools, and duration intervals do **not** cross zero on this relock. Tokens still do — do not claim a token win. n=8 is small; intervals are wide. Lead with efficiency, not the 85.4% Pass@1. Distractor and poisoned arms are coverage; poison-following 20.8% is a coverage metric, not a headline result.

### 3. Blind capability eval (35 tasks)

Source: `fixtures/eval-baselines/deepseek-blind-v2.json` from `eval-artifacts/blind-v2-relock3/eval-report.json`. Suite `internal-blind` v2 (11 coding + 6 tool_governance + 6 memory_context + 6 integration + 4 recovery_safety + 2 recovery). Dataset SHA `c2bc5528f25a86c2816d6382049dedcbbb582da99f1401ddb61504fa377a096f`. Generated `2026-09-24T15:25:55.243Z`. Gate **passed**. Adapter 400s: **0/105**. `Insufficient Balance`: 0.

Say **"35 agent tasks"**, not "35 coding tasks". Do not quote 77.1%, 93.3%, or the 96.2% relock2.

| Metric | Value |
| --- | --- |
| Scorable trials | 105 (35 × 3) |
| Trial success (Pass@1) | **98.1%** (95% Wilson CI **93.3%–99.5%**) |
| Pass@k / pass^k (k=3) | **100%** (35/35 tasks) / 97.2% |
| Duration P50 / P95 | **5.56s / 29.9s** |
| Average rounds / tool calls | **5.19 / 5.50** |
| Iteration cap hits | 9 / 105 (**8.6%**) |
| Verification completion | 55.6% |
| Workspace scope violations | 0.0% |
| Tokens (input / cached input / total) | 3,477,404 / 2,359,936 / 3,637,287 |
| Harness errors | 0.0% |
| Gate | **passed** |

Remaining failures (2, both `model_or_contract`): `recovery_repair_after_check` #2 and #3. The third repetition of that task passed, so Pass@k is 100%. `integration_create_schedule` passed on this lock after `schedule_created` was recorded on the creating task.

### 4. Tool governance slice (same run)

**Not a second independent eval.** Parent report: `fixtures/eval-baselines/deepseek-blind-v2.json`. The 18-task grouping is `tool_governance` + `integration` + `recovery_safety` + `recovery`.

| Slice | Tasks | Trials | Success |
| --- | --- | --- | --- |
| **18-task group** | **18** | **54** | **52/54 = 96.3%** |

The two misses are `recovery_repair_after_check` #2 and #3. Integration, including `integration_create_schedule`, passed on this lock.

### 5. Public suite: Aider polyglot Python (governed vs ablated)

Scorer revision after this archive: the generated suite now requires changes only in the solution source file and rejects edits to tests; `.pytest_cache` and `__pycache__` are ignored as generated files. Auditing the archived `changedPaths` found **0 non-cache test-file edits in 68 governed and 68 ablated trials**. The archived 67/68 and 68/68 scores are preserved unchanged; future runs use the stricter scorer and a new dataset hash/version.

Source: `fixtures/eval-baselines/deepseek-polyglot-python-ablation.json` from `eval-artifacts/polyglot-ablation/comparison.json`. Suite `aider-polyglot-python` 1.0.0 (34 Exercism exercises). Dataset SHA `c887849d7fa66e4fa65d33f227de42611b66543231a78ea13a14f1962b6e87a4`. Generated `2026-09-25T07:40:48.006Z`. 34 tasks × 2 reps × 2 arms. Both gates **passed**. `Insufficient Balance`: **0**. Harness errors: **0**. `costUsd` unavailable.

Each trial is one attempt (Pass@1). Aider's published leaderboard number is `pass_rate_2` (a second attempt that sees the test errors). Keep these rates off that leaderboard, and off the internal 98.1%.

Governed is product defaults. Ablated turns off compact, tool-result pruning, the file-read cache, recall, memory, repo map, promotion, experience capture, and completion verification. Sandbox, approval policy, and tool schema stay on.

The earlier governed **38.2%** (26/68) and ablated **0%** were `Insufficient Balance` deaths. Do not quote them.

| Arm | Trial success (Pass@1) | Pass@k | pass^k | Rounds / tools | P50 / P95 | Input / cached / total tokens | Cap hits |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Governed | **98.5%** (67/68; Wilson **92.1%–99.7%**) | 100% | 97.8% | 6.40 / 6.97 | 14.9s / 36.7s | 3,949,764 / 2,063,996 / 4,154,337 | 4/68 (5.9%) |
| Ablated | **100%** (68/68; Wilson **94.7%–100%**) | 100% | 100% | 6.62 / 7.32 | 13.9s / 33.0s | 4,162,163 / 3,528,704 / 4,363,729 | 5/68 (7.4%) |
| Governed − ablated | **−1.5pp** | 0pp | — | −0.22 / −0.35 | — | −212,399 / — / −209,392 | — |

The Wilson intervals overlap. On this suite the product defaults did not raise Pass@1. They used slightly fewer rounds, tool calls, and input tokens. The single governed miss is `polyglot_python_paasio` repetition 1 (`verification_failure`): completion verification rejected a no-tools final (`reasoning_only_final`), the task ended failed after 3 rounds, and pytest exited 1. The other repetition of that exercise passed, so Pass@k stays 100%.

## Archived baselines in this repo

| File | Suite | Provider / model | Repetitions | Role |
| --- | --- | --- | --- | --- |
| `fixtures/eval-baselines/xfyun-coding-astron-code-latest.json` | `reliability-acceptance` v1 (20 tasks) | xfyun-coding / astron-code-latest | 1 | Historical acceptance gate (2026-07-21). Success 90%, 7.1 rounds, P50 44s / P95 66s. **Not** the 35-task blind lock. |
| `fixtures/eval-baselines/deepseek-blind-v2.json` | `internal-blind` v2 (35 tasks) | deepseek / deepseek-flash | 3 | Blind v2 Pass@1 **relock3** 2026-09-24T15:25Z. Gate passed; traces stripped. |
| `fixtures/eval-baselines/deepseek-memory-v1.json` | `memory-compounding` v1 | deepseek / deepseek-flash | 3 | Memory paired-metrics **relock** 2026-09-24T08:42Z. Gate passed; traces stripped. |
| `fixtures/eval-baselines/deepseek-compaction-ab.json` | `long-context` v1 (8 tasks, ON vs OFF) | deepseek / deepseek-flash | 2 | Compaction A/B **relock** 2026-09-24T08:56Z (`compaction-ab-relock2/comparison.json`). Both arms 16/16; forced compact used more tokens. |
| `fixtures/eval-baselines/deepseek-polyglot-python-ablation.json` | `aider-polyglot-python` 1.0.0 (34 exercises, governed vs ablated) | deepseek / deepseek-flash | 2 | Public-suite ablation 2026-09-25T07:40Z. Governed 67/68, ablated 68/68. Single attempt, not Aider `pass_rate_2`. |

## Current lock status

- Blind v2 **relock3 archived**. Locked Pass@1 is **98.1%** (CI 93.3–99.5), Pass@k 100%, 5.19 rounds, P50 5.56s, harness 0%, gate **passed**. Do not cite 96.2%, 93.3%, or 77.1%.
- Aider polyglot Python **archived** (`deepseek-polyglot-python-ablation.json`, 2026-09-25T07:40Z). Governed Pass@1 **98.5%** (67/68), ablated **100%** (68/68), both Pass@k 100%. `Insufficient Balance` 0. Do not quote the billing-contaminated 38.2% or 0%. Do not compare these rates to Aider `pass_rate_2` or to the internal 98.1%.
- Memory four-arm **relock archived**. Locked paired reductions: rounds **9.2%**, tools **19.7%**, recall@k **62.5%**. Adapter 400s 0/96. Token interval still crosses zero. Do not cite 85.4% as a memory-system win.
- Compaction A/B **relock archived** (`compaction-ab-relock2`). Both arms **16/16**. Forced compact fired 69 vs 0 events and **increased** input tokens 79%. Do not claim a token win. Describe compaction by its mechanism and this cache result.

Blind v2, memory, and the polyglot pair are the locked results to cite. Compaction stays mechanism-only. Polyglot is the public-suite calibration: cite the pair together.

