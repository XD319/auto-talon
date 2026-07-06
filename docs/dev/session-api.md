# Session HTTP API

The session API exposes the unified SQLite session model for dashboards, integrations, and future web clients.

## Start

```bash
talon session-api serve --host 127.0.0.1 --port 7080
```

## Endpoints

### `GET /v1/sessions`

List indexed sessions.

Query params:

- `ownerUserId`
- `status` (`active`, `archived`, `deleted`)

### `GET /v1/sessions/:id`

Return session metadata plus runtime detail.

### `GET /v1/sessions/:id/messages`

Return canonical TUI-visible messages and UI state metadata.

### `GET /v1/sessions/search?q=`

Full-text search across stored session messages.

### `POST /v1/sessions/:id/continue`

Non-interactive continue endpoint.

Body:

```json
{ "input": "Pick up where we left off." }
```

Response:

```json
{
  "taskId": "...",
  "status": "succeeded",
  "output": "..."
}
```

## Notes

- All endpoints bind to localhost by default.
- Session ids are runtime `session_id` values shared by TUI, CLI, and gateway entry points.
- Legacy `.auto-talon/sessions/*.json` transcripts are migrated into SQLite by `talon doctor --fix` (one-time).
