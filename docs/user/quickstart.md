# Quickstart

1. Initialize workspace: `talon init --yes`
2. Configure a reusable user provider: `talon provider setup openai --api-key "$OPENAI_API_KEY"`
3. Open Personal Assistant workspace: `talon tui`
4. Start or continue work from today/inbox/thread views inside the TUI
5. Open runtime Ops view when needed: `talon ops` (`talon dashboard` is a compatibility alias)
6. Optional: connect a chat entry point with `talon gateway serve-feishu --cwd .`

`talon provider setup` writes user config by default, so new workspaces inherit
the selected provider. Use `talon provider setup <provider> --workspace` for a
project override, `talon provider use <provider>` to switch a saved user
selection, `talon provider promote` to copy the current effective workspace
provider into user defaults, and `talon provider status` to see which layer is
active. Environment variables such as `AGENT_PROVIDER` and
`AGENT_PROVIDER_API_KEY` still take precedence when you prefer env-managed
credentials.

First-time remote provider setup should select the real model and base URL when
the built-in defaults are not the endpoint you use. Slow coding/tool turns can
also set the request timeout explicitly, for example
`talon provider setup openai-compatible --base-url <url> --model <model> --api-key <key> --timeout-ms 120000`.
Run `talon provider smoke` to exercise the post-tool model turn with the active
provider.

Commands started from a subdirectory of an initialized workspace reuse the
nearest parent `.auto-talon/` directory. Use `--cwd` or
`AGENT_WORKSPACE_ROOT` when you want to pin a workspace explicitly.
`mock` remains available for tests and demos, but it must be selected
explicitly.

Useful checks:

- `talon continue --last`
- `talon run "summarize this project"`
- `talon task list`
- `talon trace <task_id> --summary`
- `talon audit <task_id> --summary`
