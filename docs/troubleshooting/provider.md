# Provider Troubleshooting

auto-talon does not depend on official provider SDK packages. Built-in providers use Node.js
`fetch` with OpenAI-compatible or Anthropic-compatible HTTP transports, so provider behavior is
validated through configuration, endpoint reachability, and response-shape checks.

Supported built-in providers include:

- `mock`
- `openai`
- `anthropic`
- `gemini`
- `openrouter`
- `ollama`
- `glm`
- `moonshot`
- `minimax`
- `qwen`
- `xai`
- `xfyun-coding`
- `openai-compatible`

Custom providers can be configured with `customProviders` when they expose either an
`openai-compatible` or `anthropic-compatible` transport.

- Missing key: set `AGENT_PROVIDER_API_KEY` or provider config file.
- Endpoint unreachable: check `baseUrl` and network policy.
- Model unavailable: run `talon provider test` and change `model`.
- Unsupported provider name: verify `currentProvider` / `customProviders`.

Common configuration knobs:

- Environment: `AGENT_PROVIDER`, `AGENT_PROVIDER_API_KEY`, `AGENT_PROVIDER_BASE_URL`, `AGENT_PROVIDER_MODEL`, `AGENT_PROVIDER_TIMEOUT_MS`, `AGENT_PROVIDER_MAX_RETRIES`
- File: `.auto-talon/provider.config.json`
- Current provider selector: `currentProvider`
- Provider-specific entries: `providers`
- Custom HTTP-compatible entries: `customProviders`

Diagnostics:

- `talon provider current`
- `talon provider test`
- `talon doctor`
