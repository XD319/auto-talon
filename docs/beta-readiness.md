# Minimal Beta Readiness Checklist

This phase adds the smallest practical mechanism for deciding whether the runtime is ready to move from internal validation into a beta-style rollout.

## Goals

- Make failures reproducible enough to debug.
- Make provider and prompt regressions comparable across runs.
- Make go / no-go decisions explicit instead of implicit.

## Replay Baseline

- `talon replay <task_id>` can reconstruct the key execution chain for a historical task.
- Replay can start from a chosen iteration with `--from-iteration`.
- Replay can use the currently configured provider, or a history-backed mock replay provider with `--provider mock`.
- Historical trace, tool results, approval flow, and audit entries stay visible in the replay report.
- Replay does not need to be perfectly deterministic, but it must help answer whether the failure source is primarily:
  - provider
  - prompt / context
  - tool / policy

## Eval Baseline

- `talon eval run` runs the fixed real-task sample set.
- The report must include:
  - provider name
  - model name when trace exposes it
  - task count
  - success rate
  - category success rates
  - average duration
  - average rounds
  - token usage when available
  - failure-reason distribution
  - representative failed tasks

## Beta Gate

Before entering the next stage, the runtime should satisfy all of the following:

1. Real-task sample success rate meets the agreed threshold.
2. High-risk actions keep complete trace and audit coverage.
3. Memory recall does not surface restricted data to the active context.
4. Approval allow / deny flows are stable and diagnosable.
5. Provider failures emit enough trace to identify category and likely remediation path.
6. At least one external adapter path still works end-to-end.

## CLI Entrypoints

- `talon replay <task_id> --from-iteration <n> --provider current|mock`
- `talon eval run --provider scripted-smoke|mock|glm --json --output eval-report.json`
- `talon eval beta --provider scripted-smoke|mock|glm --min-success-rate 0.8`

## Expected Use

- Use replay when a single task regresses and you need to localize the cause.
- Use eval when you want a comparable snapshot across providers or prompt changes.
- Use beta readiness when deciding whether the current build is safe to advance.
