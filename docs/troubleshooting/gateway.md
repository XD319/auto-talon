# Gateway Troubleshooting

- Webhook port in use: choose another port.
- Feishu auth invalid: verify `appId/appSecret/domain`.
- Requests denied: check gateway allowlist/denylist/rate limits.
- Adapter mismatch: verify adapter capability declarations.
- `401 unauthorized` on local webhook or session API: pass `Authorization: Bearer <token>` using `.auto-talon/http.token` or `AGENT_HTTP_TOKEN`. Run `talon init` to generate a workspace token.
- Tasks stuck in `waiting_approval`: poll `GET /tasks/:taskId/approvals`, resolve with `POST /approvals/:approvalId/resolve`, or subscribe to SSE `approval_required` on `/tasks/stream`.
- `409 session_busy`: another task is already running in the same session; retry after the active task finishes or configure `concurrency.allowParallelSessions` in `runtime.config.json`.

Checks:

- `talon gateway list-adapters`
- `talon trace <task_id>`
- `talon audit <task_id>`
