# Gateway

## Local webhook

```bash
agent gateway serve-webhook --port 7070
```

## Feishu

```bash
agent gateway serve-feishu --cwd .
```

Configuration files:

- `.auto-talon/gateway.config.json`
- `.auto-talon/feishu.config.json`

Inspect adapters:

```bash
agent gateway list-adapters
```
