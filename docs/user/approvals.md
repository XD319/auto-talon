# Approvals

High-risk tool operations may require reviewer approval.

CLI:

- `talon approve pending`
- `talon approve allow <approval_id> --reviewer <id> [--scope once|session|always]`
- `talon approve deny <approval_id> --reviewer <id>`

`--scope` defaults to `once`. Use `session` to skip repeat prompts in the current TUI session, or `always` to persist an exact-match rule in `.auto-talon/approval-rules.json`.

Approval results:

- allow resumes the paused tool call and continues the task
- deny returns a recoverable tool failure to the model so it can replan or explain the blocked action
- timeout behaves like deny; the timed-out tool call is reported as recoverable and the task continues
- later tool calls from the same pending batch are not executed after deny or timeout

TUI chat shortcuts (when input is empty):

- approval prompt opens as a bottom overlay card
- `1` allow once
- `2` allow for this TUI session
- `3` allow always for the exact same governed request
- `4` deny
- arrow keys move selection
- `Enter` confirms
- `Ctrl+C` denies the active approval prompt before exiting the app
- legacy `a` / `d` when input is empty resolve as allow once / deny

Ops dashboard (`talon ops`) approvals panel:

- `Up` / `Down` choose a pending approval
- `1`–`4` apply the same scope actions as chat
- arrow keys choose scope action, `Enter` confirms
- legacy `a` allow once, `d` deny

Clarify prompt:

- the agent can pause and ask a structured clarification question
- arrow keys choose an option
- `Tab` switches to custom answer input when allowed
- `Enter` submits the selected option or custom answer
- `Ctrl+C` cancels the active clarify prompt before exiting the app

Persistence:

- session-scoped approval grants are saved in `.auto-talon/sessions/<id>.json`
- always-allow rules are stored in `.auto-talon/approval-rules.json`
  - exact fingerprints for one-time matches
  - optional `shell_prefix` / `tool_prefix` rules created when you choose **Allow always** on shell or file tools

Policy:

- default approval gates live in `.auto-talon/policy.config.json` (`allow`, `allow_with_approval`, `deny`)
- workspace file writes are allowed by default; add a custom policy rule if you want Claude-like write gating

Audit and trace:

- `talon trace <task_id>`
- `talon audit <task_id>`
