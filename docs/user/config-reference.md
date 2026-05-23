# Config Reference

All config files live under `.auto-talon/` and include `version`.

- `provider.config.json`
- `runtime.config.json`
- `sandbox.config.json`
- `gateway.config.json`
- `feishu.config.json`
- `mcp.config.json`
- `mcp-server.config.json`
- `skill-overrides.json`

Create defaults with:

```bash
talon init --yes
```

Provider defaults are layered. AutoTalon reads the user provider config at
`~/.auto-talon/provider.config.json` first, then overlays the workspace
`.auto-talon/provider.config.json`. Workspace provider entries can override a
model, timeout, route, or project-specific provider selection while user
defaults keep auth and everyday provider selection reusable across workspaces.
`AGENT_PROVIDER*` environment variables take precedence over both layers.
Set `AGENT_USER_CONFIG_DIR` to move the user config directory.

Manage the common case through the CLI:

```bash
talon provider setup openai --api-key "$OPENAI_API_KEY"
talon provider use ollama
talon provider promote
talon provider status
```

`provider setup` and `provider use` write the user provider config by default.
Add `--workspace` when a project should keep a different provider selection or
provider entry in its workspace config. `provider promote` reads the provider
that is currently effective in the workspace and writes its provider name,
model, base URL, key, timeout, stream idle timeout, and retry settings to user
config.

Provider entries can set two provider timeout values. `timeoutMs` is the
request timeout for non-streaming calls and the connection/initial-response
timeout before a streaming response starts. `streamIdleTimeoutMs` is the
maximum gap between streaming chunks after streaming has started. Remote
providers default to a `120000` request timeout and a `300000` stream idle
timeout when a config layer does not explicitly set them; existing explicit
short request timeout entries remain effective until updated.

Streaming fallback policy: a provider that fails one streaming attempt because
of a transient network error (DNS hiccup, `TypeError: fetch failed`, idle
timeout, abort, etc.) falls back to a non-streaming request only for that
single turn and tries streaming again on the next request. Three consecutive
transient streaming failures, or any single failure that signals the endpoint
cannot stream (HTTP 4xx-shaped responses such as 501/`unsupported_capability`,
`invalid_request`, or malformed streams), persistently disables streaming for
the remainder of the runtime process and emits a `streaming_fallback`
`provider_status` event so the TUI/CLI can surface the degradation.

If neither config layer nor `AGENT_PROVIDER` selects a provider, runtime
commands open with an explicit unconfigured provider state. Task execution then
reports provider setup as required instead of silently using `mock`.

Runtime commands resolve the workspace from the current directory before they
load these files. A command started in a nested directory reuses the nearest
parent directory that already has an initialized
`.auto-talon/runtime.config.json`. Set
`AGENT_WORKSPACE_ROOT` or pass a command `--cwd` option when you need to choose
the workspace explicitly. If no parent workspace exists, commands that create a
runtime initialize the current directory with the default config files.

Run validation with:

```bash
talon doctor
```

SQLite runtime schema now includes thread continuity tables:

- `threads` for first-class thread/session containers
- `thread_runs` for each task run linked to a thread
- `thread_lineage` for branch/compress/archive lineage events
- `thread_snapshots` for structured compact/resume state (goal, open loops, blocked reason, next actions, memory links, capabilities)
- `schedules` for persisted one-shot/interval/cron schedule definitions
- `schedule_runs` for queued/running/completed/failed execution attempts, retry records, and task/thread traceability
- `inbox_items` for user-facing delivery entries (task completion/failure, approvals, memory suggestions, skill promotion suggestions)
- `commitments` for user-visible promises and their lifecycle (`open`/`blocked`/`completed` etc.)
- `next_actions` for ordered actionable continuation steps, including blocked reason and status

Provider routing and budget policy details:
- `docs/provider-routing-budget.md`

Tool availability gating details:
- `docs/tool-availability-gating.md`

Network fetch controls:
- `runtime.config.json > allowedFetchHosts` sets the public host allowlist for `web_fetch`.
- `*` allows public hosts broadly, but localhost, private IP ranges, link-local metadata endpoints, and single-label internal hostnames are still blocked.

Web search controls:
- `runtime.config.json > webSearch.backend` is `disabled` or `firecrawl`; default is `disabled`.
- `AGENT_WEB_SEARCH_BACKEND=firecrawl` enables the Firecrawl-backed `web_search` tool when `FIRECRAWL_API_KEY` is set.
- `FIRECRAWL_API_URL` can override the default Firecrawl search endpoint; the endpoint is still checked by the sandbox host policy.
- `web_search` returns normalized `{ provider, query, results[] }`; use `web_fetch` to expand selected result URLs.

Scheduled info-flow examples:
- Daily AI news: `talon schedule create "Search recent AI news, fetch the top sources, and summarize action items." --name "Daily AI news" --cron "0 8 * * *" --timezone Asia/Shanghai`
- Hourly service status check: `talon schedule create "Search public status pages for our dependencies and summarize incidents." --name "Status patrol" --every 1h`
- Weekly review: `talon schedule create "Review this week's inbox and completed tasks; produce a concise retrospective." --name "Weekly review" --cron "0 17 * * 5" --timezone Asia/Shanghai`

v0.1.0 schedule boundaries:
- Supported: one-shot `runAt`, interval `every`, cron, inbox delivery, and Feishu origin delivery.
- Not supported yet: skill-backed cron, `repeat=N`, silent suppression, per-job toolsets, browser automation, voice/TTS, image generation, sub-agent orchestration, multi-platform origin delivery, and `execute_code`.

Trace stream also includes commitment lifecycle events:
- `commitment_created|updated|blocked|unblocked|completed|cancelled`
- `next_action_created|updated|blocked|done`
