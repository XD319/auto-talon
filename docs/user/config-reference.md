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
