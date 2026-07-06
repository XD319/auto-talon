# Changelog

## Unreleased

- **Breaking:** Legacy thread→session schema and JSON session transcripts require a one-time `talon doctor --fix` after upgrade. Runtime no longer silently repairs legacy schema on every open.
- `talon doctor` warns when deprecated `compact.bufferTokens` is set (field has no runtime effect).

## v0.1.0

- First formal release of `auto-talon` as a local-first personal agent for
  CLI/TUI daily work.
- Added the `talon tui` daily agent surface, `talon run` / `talon continue`
  terminal workflows, and operational views for tasks, sessions, trace, audit,
  inbox, commitments, next actions, schedules, memory, skills, and provider
  status.
- Added governed shell/file execution with sandbox policy, explicit approvals,
  audit logs, trace events, and rollback artifacts.
- Added provider setup, selection, promotion, health checks, routing diagnostics,
  and smoke tests for the supported provider catalog.
- Added Feishu/Lark and local webhook gateway adapters plus MCP client/server
  surfaces for configured tools and skill resources.
- Added local-state bootstrap scripts (`scripts/setup.sh`, `scripts/setup.ps1`)
  and `talon init`.
- Added release convergence features: versioned DB migrations, config version
  migration, package metadata checks, npm pack dry-run validation, and
  `talon release check`.
- Expanded scripted smoke/eval fixtures for release regression scenarios.
- Added user, developer, troubleshooting, compatibility, and security
  documentation for the v0.1.0 release scope.
- Known limits: Node.js 20 is not supported; Slack, Telegram, and Discord
  adapters are not included; real provider runs require user-supplied provider
  credentials; AutoTalon is local-first and not a hosted multi-tenant service.
