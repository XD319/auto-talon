# Locked real-model evals. Concurrency must stay 1 so P50/P95 stay uncontaminated.
# Requires a configured `deepseek` provider (api key in provider.config.json or DEEPSEEK_API_KEY) and budget.pricing.deepseek.
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path "dist/cli/bin.js")) {
  throw "dist/cli/bin.js is missing. Run npm run build first."
}

$talon = "node"
$talonArgs = @("dist/cli/bin.js")

& $talon @talonArgs provider status
& $talon @talonArgs provider test
if ($LASTEXITCODE -ne 0) {
  throw "provider test failed"
}

& $talon @talonArgs eval run --provider deepseek --suite fixtures/eval-suites/internal-blind.v2.json `
  --repetitions 3 --concurrency 1 --max-cost-usd 5 `
  --output eval-artifacts/blind-v2-locked --resume eval-artifacts/blind-v2-locked
if (-not (Test-Path "eval-artifacts/blind-v2-locked/eval-report.json")) {
  throw "blind-v2 report missing"
}

& $talon @talonArgs eval run --provider deepseek --suite fixtures/eval-suites/memory-compounding.v1.json `
  --repetitions 3 --concurrency 1 `
  --output eval-artifacts/memory-locked --resume eval-artifacts/memory-locked
if (-not (Test-Path "eval-artifacts/memory-locked/eval-report.json")) {
  throw "memory report missing"
}

node --import tsx scripts/benchmark-compaction-eval.ts --provider deepseek `
  --repetitions 2 --output eval-artifacts/compaction-ab-locked
if (-not (Test-Path "eval-artifacts/compaction-ab-locked/comparison.json")) {
  throw "compaction comparison missing"
}

& $talon @talonArgs eval baseline update `
  --report eval-artifacts/blind-v2-locked/eval-report.json `
  --output fixtures/eval-baselines/deepseek-blind-v2.json `
  --min-success-rate 0 --allow-failed-gate

& $talon @talonArgs eval baseline update `
  --report eval-artifacts/memory-locked/eval-report.json `
  --output fixtures/eval-baselines/deepseek-memory-v1.json `
  --min-success-rate 0 --allow-failed-gate
