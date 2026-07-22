# AutoTalon v0.1.0

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/XD319/auto-talon/actions/workflows/ci.yml/badge.svg)](https://github.com/XD319/auto-talon/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.0-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**AutoTalon is a local-first personal agent for governed, memory-aware daily execution.**

It is not just a prompt runner and not a hosted assistant. AutoTalon gives a
single operator a long-lived agent that can talk, use tools, remember work, run
schedules, enter through chat gateways, and leave behind traces you can inspect.
The primary interactive surface is `talon tui`; the CLI is the automation and
diagnostics surface; Feishu/Lark and local webhook gateways connect external
conversations to the same runtime.

## Why AutoTalon

- **A long-lived operator agent**: `talon tui` brings conversation, sessions,
  inbox, todos, memory review, approvals, and runtime status into one terminal
  surface for the same agent.
- **Governed tool use by default**: shell, process, network, and file tools run
  through sandbox policy, approval rules, trace events, audit logs, and rollback
  artifacts.
- **Memory that compounds**: layered memory keeps profile, project, working,
  experience, and skill references available across tasks without hiding where
  recall came from.
- **Provider freedom**: configure OpenAI-compatible, Anthropic-compatible,
  Ollama, OpenRouter, GLM, Moonshot, Qwen, xAI, Gemini, MiniMax, iFLYTEK, mock,
  or custom compatible endpoints through one provider catalog.
- **Multiple entry points, one runtime**: use the same sessions and governance
  from TUI, CLI, Feishu/Lark, local webhooks, and MCP surfaces.
- **Maintainer-grade diagnostics**: replay, deterministic smoke fixtures, blind
  real-model evals, baselines, release checks, and package dry-runs are built into the source
  checkout.

## Install

Requirements:

- Node.js `>=22.13.0`
- A provider API key for real assistant runs
- Corepack only when running from source

Install the published package:

```bash
npm install -g auto-talon
talon init --yes
talon provider setup openai --api-key "$OPENAI_API_KEY"
talon provider test
talon tui
```

PowerShell users can set the provider key for the current session with:

```powershell
$env:OPENAI_API_KEY = "your-api-key"
```

To verify the CLI before configuring a real provider:

```bash
talon init --yes
talon provider setup mock
talon provider test
talon --version
```

Run from source:

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev provider setup openai --api-key "$OPENAI_API_KEY"
corepack pnpm dev provider test
corepack pnpm dev tui
```

## Workflows

Daily agent surface:

```bash
talon tui
talon ops
```

Scriptable terminal execution:

```bash
talon run "review the changed files"
talon continue --last
talon task list
talon trace <task_id> --summary
talon audit <task_id> --summary
```

Provider operations:

```bash
talon provider list
talon provider setup openai --api-key "$OPENAI_API_KEY"
talon provider use ollama
talon provider status
talon provider test
talon provider route "large coding task"
```

External entry points:

```bash
talon gateway serve-webhook --port 7070
talon gateway serve-feishu --cwd .
talon gateway list-adapters
```

Automation and continuity:

```bash
talon schedule create "Review my inbox and summarize blockers" --name "Daily inbox review" --every 1d
talon inbox list
talon commitments list
talon next list
talon memory review-queue list
```

## v0.1.0 Capabilities

| Area | What is included |
| --- | --- |
| Agent experience | TUI chat, session browsing, transcript view, status line, approvals, memory, todos, and operational panels |
| CLI execution | `run`, `continue`, task/session inspection, trace/audit views, workspace map, rollback, doctor |
| Governance | Policy engine, sandbox scopes, approval prompts, persisted allow rules, audit log, rollback snapshots |
| Memory | Profile/project/working memory, experience refs, skill refs, recall explanation, review queue, snapshots |
| Scheduling | One-shot, interval, cron, natural-language timing, execution modes, run queue, inbox/origin/webhook delivery |
| Providers | Provider catalog, setup/use/promote, health checks, smoke tests, route diagnostics, usage statistics |
| Gateways | Local webhook and Feishu/Lark adapters sharing the same runtime, identity mapping, and session commands |
| MCP and skills | MCP client/server surfaces, skill registry, skill assets, drafts, promotion, enable/disable overrides |
| Diagnostics | Scripted smoke suite, 30-task blind capability eval, scorer evidence, stability metrics, baselines, replay, release checklist |

## Security Model

AutoTalon is designed for a local operator who wants an agent with real tool
access and visible guardrails.

- Local state is stored under `.auto-talon/`, including SQLite data, logs,
  artifacts, config, approval rules, and rollback snapshots.
- High-risk tools can require explicit approval before execution. Approval
  decisions are fingerprinted and can be scoped through persisted rules.
- Shell and filesystem access are checked against sandbox policy and project
  boundaries before execution.
- Tool calls, provider events, approvals, policy decisions, file writes, and
  rollback artifacts are recorded for later inspection.
- Feishu/Lark and webhook inputs enter through gateway adapters, so they share
  the same runtime policy instead of bypassing the local governance layer.

Read [SECURITY.md](SECURITY.md) before exposing gateways or running AutoTalon
against sensitive project directories.

## Scope and Limits

- Node.js 20 is not supported. AutoTalon requires Node.js `>=22.13.0` because
  runtime storage uses the built-in `node:sqlite` module.
- AutoTalon is local-first and single-operator oriented. It is not a hosted
  SaaS, team control plane, or multi-tenant agent service.
- Real provider runs require user-supplied credentials. Mock and scripted smoke
  providers are for tests and diagnostics.
- v0.1.0 includes Feishu/Lark and local webhook gateway adapters. Slack,
  Telegram, Discord, voice, browser automation, image generation, and companion
  mobile/desktop apps are outside this release.
- `talon release check`, `talon eval run`, `talon eval acceptance`, and
  `talon smoke run` are maintainer diagnostics for source checkouts.
  Installed-package users should start with `talon doctor` and
  `talon provider test`. Upgrading from a preview checkout that still uses the
  legacy thread→session schema should run `talon doctor --fix` once.

## Docs by Goal

| Goal | Start here |
| --- | --- |
| Install and first run | [Install](docs/user/install.md), [Quickstart](docs/user/quickstart.md) |
| Learn CLI/TUI commands | [Commands](docs/user/commands.md) |
| Configure providers and runtime | [Config reference](docs/user/config-reference.md), [Provider troubleshooting](docs/troubleshooting/provider.md) |
| Understand approvals and sandboxing | [Approvals](docs/user/approvals.md), [Sandbox troubleshooting](docs/troubleshooting/sandbox.md) |
| Connect external entry points | [Gateway](docs/user/gateway.md), [Gateway troubleshooting](docs/troubleshooting/gateway.md) |
| Use memory and skills | [Skills](docs/user/skills.md), [Memory troubleshooting](docs/troubleshooting/memory.md) |
| Integrate MCP | [MCP](docs/user/mcp.md) |
| Validate a release | [Replay and eval](docs/user/replay-and-eval.md), [Compatibility matrix](docs/compatibility-matrix.md) |
| Develop AutoTalon | [Architecture](docs/dev/architecture.md), [Module boundaries](docs/dev/module-boundaries.md), [Testing](docs/dev/testing.md) |

## Release Validation

Run these checks before tagging or publishing v0.1.0:

```bash
corepack pnpm check
npm run release:check
npm pack --dry-run --json
```

The full suite can take several minutes. `release check` prints its current
stage and gives each child command a ten-minute timeout. If `corepack pnpm
check` has already passed in the same clean checkout, avoid repeating lint,
tests, and build with:

```bash
npm run release:check -- --skip-quality-checks
```

Before publishing, verify the npm identity and then validate the exact version
from the registry after publication:

```bash
npm whoami
npm publish --access public
npm install -g auto-talon@0.1.0
talon --version
talon doctor
```

After installing or updating a local project:

```bash
talon doctor
talon provider test
```

The release checklist covers lint, tests, build, smoke/eval threshold, beta
readiness, schema baseline, Node version policy, npm metadata, lockfile policy,
setup scripts, and package contents.

## License

MIT. See [LICENSE](LICENSE).


### Long-term memory

Long-term memory is off by default. Use /memory on, /memory off, or 	alon memory on|off; see [docs/user/memory.md](docs/user/memory.md).
