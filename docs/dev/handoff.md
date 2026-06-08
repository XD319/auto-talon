# Session Handoff

Cross-platform session handoff keeps one runtime `session_id` active across TUI, CLI, and gateway adapters.

## Model

- Runtime `session_id` remains canonical in SQLite.
- Gateway bindings store `runtime_session_id` per `(adapter_id, external_session_id)`.
- Handoff creates or updates a binding; it does not copy transcripts.
- Resume locally with `talon tui --resume <session_id>` or `/resume <session_id>`.

## TUI

- `/handoff <adapter> [external-session-id]` - flush current transcript, bind session to gateway target.
- `/handoff status` - list gateway bindings for the active session.
- `/branch [name]` - fork current transcript into a new session (`session_lineage.branch`).
- `/clear [name]` - save current session (optional name), start a new session.
- `/new [title]` - start a fresh named assistant session.

## CLI

```bash
talon session handoff --session <session_id> --adapter feishu [--external-session <id>]
talon tui --resume "Refactor auth"
```

## Gateway

Gateway chats can manage bindings without starting a task:

- `/sessions`
- `/resume <session-id-prefix-or-title>`

## Differences from Hermes `/handoff`

- No `/sethome`; target adapter/channel comes from command args and adapter config.
- TUI stays open by default after handoff (no forced CLI exit).
- Handoff notifications use gateway binding metadata rather than synthetic user turns in `session_messages`.

## Dependencies

- Flush before handoff (`saveSessionUiState`) so cross-platform resume sees the latest transcript.
- Mid-turn handoff is rejected while a task, approval, or clarification is active.
