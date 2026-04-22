# Provider Troubleshooting

- Missing key: set `AGENT_PROVIDER_API_KEY` or provider config file.
- Endpoint unreachable: check `baseUrl` and network policy.
- Model unavailable: run `agent provider test` and change `model`.
- Unsupported provider name: verify `currentProvider` / `customProviders`.

Diagnostics:

- `agent provider current`
- `agent provider test`
- `agent doctor`
