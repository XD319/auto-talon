# Phase 6 Gateway Feishu Entry

Phase 6 promotes messaging gateway from MVP boundary validation to a formal external entry.

## Scope

- first formal IM platform: Feishu/Lark
- full ingress chain: message -> task -> approval callback -> completion callback
- runtime remains platform-agnostic (no Feishu SDK imports under runtime core folders)

## Required Feishu Setup

1. Create a self-built enterprise app in Feishu/Lark open platform.
2. Enable permissions:
   - `im:message`
   - `im:message:send_as_bot`
   - `im:chat:readonly`
3. Enable event subscriptions:
   - `im.message.receive_v1`
   - `card.action.trigger`
4. Use long connection mode (WSClient).

## Runtime Configuration

Create `.auto-talon/feishu.config.json`:

```json
{
  "appId": "cli_xxx",
  "appSecret": "xxx",
  "domain": "feishu"
}
```

Or provide:

- `AGENT_FEISHU_APP_ID`
- `AGENT_FEISHU_APP_SECRET`
- `AGENT_FEISHU_DOMAIN`
- `AGENT_FEISHU_DEBUG` (set `1` or `true` to enable verbose adapter/sdk logs)

Legacy compatibility:

- `AUTO_TALON_FEISHU_DEBUG` is still supported as a fallback debug flag.

## Commands

- `talon gateway serve-feishu --cwd .`
- `talon gateway serve-feishu --cwd . --local-webhook-port 7070`
- `talon gateway list-adapters --cwd .`
