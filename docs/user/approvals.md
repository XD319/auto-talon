# Approvals

High-risk tool operations may require reviewer approval.

CLI:

- `talon approve pending`
- `talon approve allow <approval_id> --reviewer <id>`
- `talon approve deny <approval_id> --reviewer <id>`

TUI shortcuts (when input is empty):

- approval prompt now opens as a bottom overlay card
- `1` allow once
- `2` allow for this TUI session
- `3` allow always for the exact same governed request
- `4` deny
- arrow keys move selection
- `Enter` confirms
- `Ctrl+C` denies the active approval prompt before exiting the app

Clarify prompt:

- the agent can pause and ask a structured clarification question
- arrow keys choose an option
- `Tab` switches to custom answer input when allowed
- `Enter` submits the selected option or custom answer
- `Ctrl+C` cancels the active clarify prompt before exiting the app

Persistence:

- session-scoped approval grants are saved in `.auto-talon/sessions/<id>.json`
- always-allow exact approval rules are stored in `.auto-talon/approval-rules.json`

Audit and trace:

- `talon trace <task_id>`
- `talon audit <task_id>`
