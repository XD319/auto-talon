# Approvals

High-risk tool operations may require reviewer approval.

CLI:

- `talon approve pending`
- `talon approve allow <approval_id> --reviewer <id>`
- `talon approve deny <approval_id> --reviewer <id>`

TUI shortcuts (when input is empty):

- `a` approve
- `d` deny

Audit and trace:

- `talon trace <task_id>`
- `talon audit <task_id>`
