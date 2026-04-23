# Plugin Development

## Provider adapter

1. Implement provider contract in `src/providers/`.
2. Register in provider registry.
3. Add config handling and tests.

## Gateway adapter

1. Implement inbound adapter interface in `src/gateway/`.
2. Declare capabilities explicitly.
3. Route all runtime actions through `GatewayRuntimeFacade`.

## Skill

1. Create `SKILL.md` in `.auto-talon/skills/<namespace>/<name>/`.
2. Add optional attachments (`references`, `templates`, `scripts`, `assets`).
3. Validate via `talon skills list` and `talon skills view`.
