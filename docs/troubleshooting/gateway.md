# Gateway Troubleshooting

- Webhook port in use: choose another port.
- Feishu auth invalid: verify `appId/appSecret/domain`.
- Requests denied: check gateway allowlist/denylist/rate limits.
- Adapter mismatch: verify adapter capability declarations.

Checks:

- `talon gateway list-adapters`
- `talon trace <task_id>`
- `talon audit <task_id>`
