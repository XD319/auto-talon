# Compatibility Matrix (v0.1.0)

## Provider

- `mock` + `scripted-smoke`: supported and covered in CI smoke/eval.
- `glm` + `openai-compatible` transport: supported; validate with `talon provider test`.
- `xfyun-coding` + `openai-compatible` transport: supported; validate with `talon provider test`.
- `anthropic-compatible` custom providers: supported via `customProviders`.

## Gateway

- `local-webhook`: supported (`talon gateway serve-webhook`).
- `feishu`: supported (`talon gateway serve-feishu`).
- Other adapters (Slack/Telegram/Discord): not included in v0.1.0.

## Memory / Storage

- Runtime schema baseline: `PRAGMA user_version = 2`.
- Schema upgrades from legacy unversioned DB: supported via migration pipeline.
- Config files without `version`: auto-migrated to `version: 1`.

## Skills

- Sources: project + local skill roots supported.
- Attachments: `references`, `templates`, `scripts`, `assets`.
- Overrides: `.auto-talon/skill-overrides.json` supported.

## Validation Path

- `talon release check` from the auto-talon repository root
- `talon eval run`
- `talon eval smoke`
- `talon eval beta`
