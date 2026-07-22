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

The Feishu/Lark adapter is a formal chat entry point into the same runtime used
by `talon tui`. The Lark SDK (`@larksuiteoapi/node-sdk`) ships with the
`auto-talon` package dependency set; no separate install is required when you
install AutoTalon from npm or build from this repository.

```bash
talon gateway serve-feishu --cwd .
```

Configuration files:

- `.auto-talon/gateway.config.json`
- `.auto-talon/feishu.config.json`

You can also set `AGENT_FEISHU_APP_ID`, `AGENT_FEISHU_APP_SECRET`, and optional
`AGENT_FEISHU_DOMAIN` (`feishu` or `lark`). See
[Phase 6 Feishu setup](../phase6-gateway-feishu.md) for open-platform permissions
and event subscriptions.

Inspect adapters:

```bash
talon gateway list-adapters
```

Feishu schedule commands:

```text
/schedule create 1分钟后 | say hello
/schedule create cron 0 17 * * 5 | weekly review
/schedule preview cron 0 17 * * 5
/schedule show <schedule-id-prefix>
/schedule edit <schedule-id-prefix> cron 0 9 * * *
/schedule runs <schedule-id-prefix>
```

Schedule timing validation is explicit. Invalid cron expressions, ambiguous
timing fields, or unavailable declared toolsets fail with a visible error
instead of falling back to another model, channel, or execution path.

### Feishu manual E2E checklist

Run this once against a real Feishu/Lark app before relying on the adapter in
production. Automated unit and mock-SDK E2E tests do not replace this path.

1. Configure credentials in `.auto-talon/feishu.config.json` or via
   `AGENT_FEISHU_*` environment variables.
2. Start the adapter: `talon gateway serve-feishu --cwd .`
3. Confirm `talon gateway list-adapters` shows the Feishu adapter as available.
4. Send a normal chat message to the bot and confirm a task starts (reply or
   progress card appears).
5. Trigger a high-risk action so an approval card appears; press **allow** and
   **deny** at least once each and confirm the task resumes or stops correctly.
6. After a successful task, spot-check `/sessions` and `/resume <session-id>`
   from the Feishu chat.
7. If anything fails, set `AGENT_FEISHU_DEBUG=1` and consult
   [Gateway troubleshooting](../troubleshooting/gateway.md).
