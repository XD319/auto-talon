# Gateway

## Local webhook

```bash
talon gateway serve-webhook --port 7070
```

Submit a buffered task:

```bash
curl -X POST http://127.0.0.1:7070/tasks \
  -H "Content-Type: application/json" \
  -d '{"requester":{"externalSessionId":"local-session","externalUserId":"local-user","externalUserLabel":"Local User"},"taskInput":"summarize runtime status"}'
```

Submit a task and stream live output in the same response:

```bash
curl -N -X POST http://127.0.0.1:7070/tasks/stream \
  -H "Content-Type: application/json" \
  -d '{"requester":{"externalSessionId":"local-session","externalUserId":"local-user","externalUserLabel":"Local User"},"taskInput":"summarize runtime status"}'
```

The stream uses Server-Sent Events with named events such as
`output.assistant_turn_delta`, `output.result`, `progress`, `gateway.result`,
and a terminal `done` event. Existing task history remains available through
`GET /tasks/:taskId/events`.

## Feishu

The Feishu/Lark adapter is loaded as an optional gateway plugin so the core CLI
runtime stays lightweight. Install the Lark SDK only in workspaces that run this
adapter. This is a formal chat entry point into the same runtime used by
`talon tui`, not just an adapter demo:

```bash
pnpm add @larksuiteoapi/node-sdk
```

```bash
talon gateway serve-feishu --cwd .
```

Configuration files:

- `.auto-talon/gateway.config.json`
- `.auto-talon/feishu.config.json`

Inspect adapters:

```bash
talon gateway list-adapters
```
