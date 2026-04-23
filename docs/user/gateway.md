# Gateway

## Local webhook

```bash
talon gateway serve-webhook --port 7070
```

## Feishu

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
