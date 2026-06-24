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

- Environment: `AGENT_PROVIDER`, `AGENT_PROVIDER_API_KEY`, `AGENT_PROVIDER_BASE_URL`, `AGENT_PROVIDER_MODEL`, `AGENT_PROVIDER_TIMEOUT_MS`, `AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS`, `AGENT_PROVIDER_MAX_RETRIES`
- User defaults: `~/.auto-talon/provider.config.json`
- Workspace overrides: `.auto-talon/provider.config.json`
- User config directory override: `AGENT_USER_CONFIG_DIR`
- Current provider selector: `currentProvider`
- Provider-specific entries: `providers`
- Custom HTTP-compatible entries: `customProviders`
- Model aliases for `/model`: `modelAliases`
- Fallback provider chain: `fallbackProviders`
- Auxiliary model slots: `.auto-talon/runtime.config.json` → `auxiliary`

In `talon tui`, `/model` switches among already-configured providers without
restarting the TUI. Provider visibility is global-first: user-level providers in
`~/.auto-talon/provider.config.json` appear in every workspace. Workspace config
can override fields for the current project or add workspace-only custom providers.
Use `talon model`, `talon provider setup`, or `talon provider custom add` to add
providers and credentials outside the session.

Model routing notes:

- `runtime.config.json` → `routing.providers` selects tiered main providers when no explicit `/model` or `talon model set` switch is active in the session.
- After an explicit switch, that provider is used for main turns until you switch again (soft budget downgrade can still move main turns to the cheap tier).
- Auxiliary slots in `runtime.config.json` → `auxiliary` set to `auto` follow the current main provider.
- `modelAliases` can be used with `/model`, but persisted config writes the resolved provider name.
- `AGENT_PROVIDER` is applied at startup and can override a saved `currentProvider`.
- `talon model list` and `talon model status` currently return the same summary.

New workspaces do not choose `mock` automatically. If diagnostics show
`Provider: unconfigured`, run `talon provider setup <provider>` to save a user
default, or select a provider through `AGENT_PROVIDER`. Keep workspace overrides
only where a project needs them. Select `mock` explicitly for tests or demos.
If a workspace already has the right endpoint and model, run
`talon provider promote` there to make that effective provider config the user
default for new workspaces.

Diagnostics:

- `talon provider status`
- `talon provider test`
- `talon provider smoke`
- `talon doctor`

When a tool succeeds and the next provider turn fails with `timeout_error`,
check `talon provider status` first. Older explicit remote provider entries may
still carry a `30000` request timeout; `status` and `doctor` warn about that
without rewriting it. Update the active config layer with
`talon provider setup <provider> --timeout-ms 120000` and use
`talon provider smoke` to exercise a synthetic post-tool turn. For streaming
providers, raise `--stream-idle-timeout-ms` only when the response starts but
then goes silent between chunks.
