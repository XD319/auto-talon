# Config Reference

All config files live under `.auto-talon/` and include `version`.

- `provider.config.json`
- `runtime.config.json`
- `policy.config.json`
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

MCP client config supports one local and one remote transport path:

- `type: "stdio"` with `command`, `args`, optional `env`, and optional `cwd`.
- `type: "streamable_http"` with `url`, optional `headers`,
  `envHeaders`, and `bearerTokenEnvVar`.

Common MCP server fields are `enabled`, `required`, `alwaysLoad`,
`enabledTools`, `disabledTools`, `startupTimeoutMs`, `toolTimeoutMs`,
`riskLevel`, and `privacyLevel`. `alwaysLoad: false` keeps tools in the MCP
catalog until `mcp_tool_search` materializes a matching tool.

`mcp-server.config.json` uses `exposeTools` as an explicit string array. Legacy
`true` is treated as the default read-oriented allowlist; `false` exposes no
runtime tools.

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

Keep provider secrets in environment variables or user config when possible.
`talon doctor` warns when workspace `.auto-talon/provider.config.json` contains
plaintext secret fields such as `apiKey`; the warning names only the field path
and never prints the secret value.

Runtime shell and test commands are capped by
`.auto-talon/runtime.config.json` `workflow.maxShellTimeoutMs`, defaulting to
`30000`. Pending approval requests expire after `approvalTtlMs` (default
`300000`, five minutes). Set `AGENT_SHELL_MAX_TIMEOUT_MS` to override shell
timeout for long local builds or test suites without changing workspace config. `workflow.shellBackend`
selects `default`, `powershell`, `cmd`, `git-bash`, `wsl`, `docker-sh`, or
`custom`; set `AGENT_SHELL_BACKEND` to override it per environment. When using
`custom`, set `workflow.customShell` with `executable` and optional `args`.
`docker-sh` reuses the Docker shell sandbox path and requires Docker to be
available.

`workflow.testCommands` accepts the existing string array form, such as
`["npm test", "npm run build"]`, or named command entries:
`[{ "name": "test", "command": "npm test", "category": "test", "timeoutMs": 120000 }]`.
Use the `name` with `test_run` for stable prompts while keeping the shell
command configurable per workspace.

`workflow.longRunningCommands` defines named commands for `terminal_start`,
for example
`[{ "name": "dev", "command": "npm run dev", "cwd": "web", "env": { "NODE_ENV": "development" } }]`.
Use `terminal_start` with `{ "name": "dev" }` to run the configured command
through the same sandbox, approval, trace, and audit path as direct shell
commands.

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

SQLite runtime schema now includes session continuity tables:

- `sessions` for first-class session containers
- `session_tasks` for each task run linked to a session
- `session_lineage` for branch/compress/archive lineage events
- `session_summary_events` for structured compact/resume state (goal, open loops, blocked reason, next actions, memory links, capabilities)
- `schedules` for persisted one-shot/interval/cron schedule definitions
- `schedule_runs` for queued/running/completed/failed execution attempts, retry records, and task/session traceability
- `inbox_items` for user-facing delivery entries (task completion/failure, approvals, memory suggestions, skill promotion suggestions)
- `commitments` for user-visible promises and their lifecycle (`open`/`blocked`/`completed` etc.)
- `next_actions` for ordered actionable continuation steps, including blocked reason and status

Provider routing and budget policy details:
- `docs/provider-routing-budget.md`

Tool availability gating details:
- `docs/tool-availability-gating.md`

Network fetch controls:
- `runtime.config.json > allowedFetchHosts` sets the public host allowlist for `web_extract` and search provider API endpoints used by `web_search`.
- `*` allows public hosts broadly, but localhost, private IP ranges, link-local metadata endpoints, and single-label internal hostnames are still blocked.

Web search controls:
- `runtime.config.json > web` is the preferred web configuration surface.
- `web.backend`, `web.searchBackend`, and `web.extractBackend` default to `auto`, `auto`, and `http` respectively. With no provider credentials, `auto` search resolves to built-in zero-config search (`ddgs`: DuckDuckGo with Bing HTML fallback).
- `web.backend`, `web.searchBackend`, and `web.extractBackend` support `auto`, `disabled`, and provider-specific values.
- Search backends: `firecrawl`, `tavily`, `exa`, `searxng`, `brave`, and `ddgs`.
- Extract backends: `firecrawl`, `tavily`, `exa`, and local sandboxed `http`.
- `searxng`, `brave`, and `ddgs` are search-only; extraction falls back to `http` unless an extract backend is configured.
- `webSearch` remains supported as a legacy Firecrawl-only compatibility field.
- Historical workspaces with only `"webSearch": { "backend": "disabled" }` keep search disabled until a `web.searchBackend` is added or an env override is provided.
- Env overrides:
  - `AGENT_WEB_BACKEND`
  - `AGENT_WEB_SEARCH_BACKEND`
  - `AGENT_WEB_EXTRACT_BACKEND`
  - `AGENT_WEB_SEARCH_MAX_RESULTS`
  - `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL`
  - `TAVILY_API_KEY`, `EXA_API_KEY`, `SEARXNG_URL`, `DDGS_URL`, `BRAVE_SEARCH_API_KEY`
- `DDGS` works out of the box via built-in DuckDuckGo search (with Bing HTML fallback when DuckDuckGo is blocked). Optionally set `web.providers.ddgs.apiUrl` or `DDGS_URL` to use a JSON HTTP gateway instead.
- `web_search` returns normalized `{ provider, query, results[] }`; each result may include `citation` metadata with `{ citationId, url, title, citedText, source }`. Use `web_extract` to expand selected result URLs.
- `web_extract` accepts an optional `prompt` string up to 2000 characters. Without `prompt`, extraction keeps the normal full/summarized behavior. With `prompt`, extraction returns a page-grounded answer with `extractionMode: "prompt_extract"` and `citations[]`.
- Successful `web_extract` results are cached in-process for 15 minutes by backend, URL, prompt, `maxBytes`, and `summaryTargetBytes`. Tool output includes `cached: false` on the first read and `cached: true` on cache hits.
- Web search v1 does not include browser rendering, Playwright-backed extraction, or dynamic code filtering.

Extract-only configuration:

```json
{
  "web": {
    "searchBackend": "disabled",
    "extractBackend": "http"
  }
}
```

API-backed search configuration:

```json
{
  "web": {
    "searchBackend": "firecrawl",
    "extractBackend": "http",
    "providers": {
      "firecrawl": {
        "apiKeyEnv": "FIRECRAWL_API_KEY",
        "apiUrl": "https://api.firecrawl.dev/v1/search"
      }
    }
  }
}
```

Self-hosted search configuration:

```json
{
  "web": {
    "searchBackend": "searxng",
    "extractBackend": "http",
    "providers": {
      "searxng": {
        "apiUrl": "https://search.example.com/search"
      }
    }
  }
}
```

Example split configuration:

```json
{
  "web": {
    "searchBackend": "brave",
    "extractBackend": "http",
    "maxResults": 8,
    "providers": {
      "brave": {
        "apiKeyEnv": "BRAVE_SEARCH_API_KEY",
        "apiUrl": "https://api.search.brave.com/res/v1/web/search"
      }
    }
  }
}
```

Governance:
- `policy.config.json` controls default policy effect and rule list (`allow`, `allow_with_approval`, `deny`) matched by capability, tool, profile, and path scope.
- `approval-rules.json` stores user-granted always-allow fingerprints and optional shell/file prefix rules.
- See also `docs/user/approvals.md` and `docs/phase2-governance.md`.

Scheduled info-flow examples:
- Daily AI news: `talon schedule create "Search recent AI news, fetch the top sources, and summarize action items." --name "Daily AI news" --cron "0 8 * * *" --timezone Asia/Shanghai`
- Hourly service status check: `talon schedule create "Search public status pages for our dependencies and summarize incidents." --name "Status patrol" --every 1h`
- Weekly review: `talon schedule create "Review this week's inbox and completed tasks; produce a concise retrospective." --name "Weekly review" --cron "0 17 * * 5" --timezone Asia/Shanghai`

Schedule boundaries in v0.1.0:
- Supported: one-shot `runAt` (including relative `30m` / `2h`), interval `every`, cron, natural-language `when`, timing preview, execution modes (`isolated` / `continue` / `session:<id>`), agent `cronjob` tool, skill binding, per-job toolsets, `noAgent` script runs, `repeatRemaining`, delivery targets (`inbox` / `origin` / `silent` / `webhook`), `schedule run --wait`, and configurable `scheduler.pollIntervalMs`. CLI `schedule create` covers timing and execution mode; advanced metadata is exposed through `cronjob` and gateway APIs.
- Scheduled runs deny nested schedule management via `cronjob` unless explicitly designed otherwise; `delegate_task` is disabled unless `metadata.allowDelegate: true` on the schedule.
- Scheduled agent runs run a lightweight prompt-injection scan before execution.
- Runtime behavior is fail-explicit: invalid timing, missing declared toolsets, and delivery/execution errors are recorded on the run instead of using hidden fallback channels or alternate execution paths.
- Not supported yet: Heartbeat ambient subsystem, browser automation, voice/TTS, image generation, multi-platform origin delivery beyond Feishu, and `execute_code`.

Trace stream also includes commitment lifecycle events:
- `commitment_created|updated|blocked|unblocked|completed|cancelled`
- `next_action_created|updated|blocked|done`
