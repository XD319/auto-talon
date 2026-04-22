# Module Boundaries

- `runtime/`: composition root, execution lifecycle, app service.
- `providers/`: provider config + transport adapters.
- `tools/`: tool implementations and orchestration.
- `policy/`: allow/approval/deny decision rules.
- `gateway/`: external ingress adapters.
- `storage/`: SQLite migrations and repositories only.
- `tui/`: presentation and interaction only.

Boundary rules:

- Gateway must not bypass runtime service/repositories.
- TUI must not query repositories directly.
- Providers do not persist data directly.
