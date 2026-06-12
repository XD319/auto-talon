# Commands

Core:

- `talon run`
- `talon continue --last|--session <id> [task]`
- `talon tui`
- `talon tui --continue`
- `talon tui --resume <session_id|title>`
- `talon session-api serve`
- `talon ops`
- `talon dashboard` (compatibility alias of `talon ops`)
- `talon init`
- `talon doctor`
- `talon version`

Operational:

- `talon task list|show|timeline`
- `talon session list|show|archive|search <query>`
- `talon session handoff --session <id> --adapter <adapter> [--external-session <id>]`
- `talon schedule create|list|show|edit|pause|resume|run-now|runs|remove|status|tick|run`
- `talon inbox [--status <status>]`
- `talon inbox list|show|done|dismiss`
- `talon commitments list|show|create|block|unblock|complete|cancel`
- `talon next list|add|done|block|unblock|resume`
- `talon trace [task_id] [--summary]`
- `talon trace context <task_id>`
- `talon audit <task_id> [--summary]`
- `talon approve pending|allow|deny`
- `talon workspace map|rollback`
- `talon repo map` (deprecated alias)

Subsystems:

- `talon provider list|current|status|setup|use|promote|test|smoke|stats|route`
- `talon budget show --task <id>|--session <id>`
- `talon memory list|show|search|snapshot|review|guide|add|forget|why|review-queue`
- `talon experience list|show|review|promote|search`
- `talon skills list|view|enable|disable|draft|promote|rollback`
- `talon gateway serve-webhook|serve-feishu|list-adapters`
- `talon mcp list|ping|serve`
- `talon sandbox`
- `talon config doctor`

Maintainer diagnostics for source checkouts:

- `talon replay <task_id> [--dry-run]`
- `talon eval run --fixture <path> [--explain]`
- `talon eval smoke --fixture <path>` (compatibility alias)
- `talon smoke run --fixture <path>`
- `talon eval beta`
- `talon release check` (maintainer-only; run from the auto-talon repository root)

TUI slash commands (chat mode):

- `/clear [name]` (save current session and start a new one)
- `/new [title]` (start a fresh named assistant session)
- `/branch [name]` (fork current transcript)
- `/handoff <adapter> [external-session-id]`
- `/handoff status`
- `/sessions` (session picker)
- `/resume <session-id-prefix|title>`
- `/next list [session-id-prefix]`
- `/next done <next-action-id-prefix>`
- `/next block <next-action-id-prefix> <reason...>`
- `/commitments list [session-id-prefix]`
- `/commitments done <commitment-id-prefix>`
- `/commitments block <commitment-id-prefix> <reason...>`
- `/schedule list [active|paused|completed|archived|all]`
- `/schedule create <when> | <prompt>`
- `/schedule pause|resume|run-now|runs|remove <schedule-id-prefix>`
- `/memory`
- `/memory review`
- `/memory add <profile|project> <text>`
- `/memory forget <memory-id-prefix>`
- `/memory why [memory-id-prefix]`

Schedule notes (v0.2):

- `talon schedule create` accepts `--at 30m`, `--every 2h`, and `--execution-mode isolated|continue|session:<id>`. `--session` requires an execution mode; isolated schedules always run in a fresh session. Advanced fields (`deliveryTargets`, `skills`, `toolsets`, `noAgent`, `repeatRemaining`) are available via the agent `cronjob` tool or gateway API.
- `talon schedule preview <expr> [--timezone TZ] [--count N]` validates one timing expression and prints upcoming fire times without creating a schedule.
- `talon schedule run <schedule-id> --wait [--timeout MS] [--poll-interval MS]` blocks until the run reaches a terminal state.
- Agent `cronjob` tool manages schedules in chat; scheduled runs cannot nest further schedule edits unless you opt in.
- Scheduled agent runs are scanned for prompt-injection patterns before execution; set `metadata.allowDelegate: true` to allow `delegate_task` during a scheduled run.
- Feishu `/schedule create cron <expr> | <prompt>` and `/schedule edit <id> cron <expr>` expose native cron in chat; unsupported timing or missing toolsets fail explicitly instead of falling back to another execution path.
