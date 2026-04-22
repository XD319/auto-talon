# Approvals

High-risk tool operations may require reviewer approval.

CLI:

- `agent approve pending`
- `agent approve allow <approval_id> --reviewer <id>`
- `agent approve deny <approval_id> --reviewer <id>`

TUI shortcuts (when input is empty):

- `a` approve
- `d` deny

Audit and trace:

- `agent trace <task_id>`
- `agent audit <task_id>`
