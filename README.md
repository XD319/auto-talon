# auto-talon v0.1.0

CLI-first agent runtime with governance, traceability, and reproducible execution.

auto-talon is for engineers who want an agent runner they can inspect, replay,
gate with policy, and connect to local or team workflows without starting from a
web app. It keeps the core runtime focused on command-line operation while
exposing structured audit, trace, memory, skills, gateway, and evaluation
surfaces.

## What It Does

- Runs agent tasks from the terminal with configurable provider profiles.
- Records task state, trace events, tool calls, approvals, and audit logs in a
  local SQLite workspace.
- Gates risky tool use with policy and explicit approval flows.
- Supports replay, smoke tests, eval reports, and maintainer release checks.
- Provides memory, experience capture, and skill recall for repeatable work.
- Exposes optional gateway adapters for local webhooks and Feishu/Lark.
- Includes Ink-based TUI and dashboard views for operators who want an
  interactive shell-native surface.

## Demo

```text
$ talon init --yes
Initialized .auto-talon workspace files.

$ talon run "summarize this repository"
task_id=task_...
status=succeeded
output=This repository contains a CLI-first agent runtime...

$ talon trace task_... --summary
provider.call -> tool.call -> tool.result -> task.completed

$ talon audit task_... --summary
policy decisions, approvals, sandbox decisions, and file writes are recorded.
```

## Quick Start

Requirements:

- Node.js `>=22.5.0`
- Corepack enabled for source installs

Installed package:

```bash
npm install -g auto-talon
talon init --yes
talon run "summarize this repository"
```

Source checkout:

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev run "summarize this repository"
```

## Common Workflows

Run and inspect a task:

```bash
talon run "review the changed files"
talon task list
talon trace <task_id> --summary
talon audit <task_id> --summary
```

Use the interactive surfaces:

```bash
talon tui
talon dashboard
```

Validate providers and release readiness:

```bash
talon provider list
talon provider test
talon eval smoke
talon release check
```

Serve integrations:

```bash
talon gateway serve-webhook --port 7070
talon gateway serve-feishu --cwd .
talon gateway list-adapters
```

## When To Use It

- You want a local-first agent runtime with auditable execution history.
- You need policy and approval behavior before allowing file or shell actions.
- You want replay/eval tooling around agent tasks instead of one-off prompts.
- You are building gateway integrations where chat, webhook, or MCP surfaces
  should all route through the same governed runtime.

## Positioning

auto-talon is closer to an inspectable runtime than a hosted coding assistant. It
prioritizes CLI operation, governance, traceability, and reproducible task
execution. Compared with broader agent shells, the project is intentionally
small: the core package avoids heavyweight optional integrations, and adapters
such as Feishu/Lark are loaded only when their gateway command is used.

## Documentation

User docs:

- `docs/user/install.md`
- `docs/user/quickstart.md`
- `docs/user/commands.md`
- `docs/user/replay-and-eval.md`
- `docs/user/approvals.md`
- `docs/user/skills.md`
- `docs/user/gateway.md`
- `docs/user/mcp.md`
- `docs/user/config-reference.md`

Developer docs:

- `docs/dev/architecture.md`
- `docs/dev/module-boundaries.md`
- `docs/dev/plugin-development.md`
- `docs/dev/testing.md`

Troubleshooting:

- `docs/troubleshooting/provider.md`
- `docs/troubleshooting/sandbox.md`
- `docs/troubleshooting/gateway.md`
- `docs/troubleshooting/memory.md`

## Release Validation

```bash
corepack pnpm check
corepack pnpm dev release check
```

`talon release check` is a maintainer release gate for this repository. Use
`talon doctor` for user workspace health checks.

