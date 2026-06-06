# Commands

Core:

- `talon run`
- `talon continue --last|--session <id> [task]`
- `talon tui`
- `talon ops`
- `talon dashboard` (compatibility alias of `talon ops`)
- `talon init`
- `talon doctor`
- `talon version`

Operational:

- `talon task list|show|timeline`
- `talon session list|show|archive <session_id>`
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

- `/session` (alias of `/session summary`)
- `/session new [title]`
- `/session list`
- `/session switch <session-id-prefix>`
- `/session summary [session-id-prefix]`
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
