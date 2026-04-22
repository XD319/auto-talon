# Gateway Troubleshooting

- Webhook port in use: choose another port.
- Feishu auth invalid: verify `appId/appSecret/domain`.
- Requests denied: check gateway allowlist/denylist/rate limits.
- Adapter mismatch: verify adapter capability declarations.

Checks:

- `agent gateway list-adapters`
- `agent trace <task_id>`
- `agent audit <task_id>`
