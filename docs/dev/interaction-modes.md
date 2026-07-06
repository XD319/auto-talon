# Interaction Modes

Talon gates **what tools can run** before execution, similar to Claude Code plan/default modes and Codex sandbox profiles. Modes are chosen by the user (`/mode`, `Shift+Tab`, or `defaultInteractionMode` in `runtime.config.json`), not inferred from prompt wording.

## Modes

| Mode | Tools | Typical use | Claude Code / Codex analogue |
|------|-------|-------------|----------------------------|
| `agent` | Full tool surface (subject to policy) | Implementation and mixed tasks | Default agent / workspace-write |
| `plan` | Read-only tools only (`isPlanSafeTool`) | Analysis, review, structured plans | Plan mode / read-only sandbox |
| `acceptEdits` | Full tools; workspace file writes auto-allowed | Fast edit loops with shell still gated | Accept-edits mode |

## Switching in the TUI

- `/mode plan`, `/mode agent`, `/mode acceptEdits`
- **Shift+Tab** cycles `agent → plan → acceptEdits → agent`
- Current mode appears in the status line and is persisted with session UI state

## Configuration

```json
{
  "defaultInteractionMode": "agent",
  "interactionModes": {
    "agentWriteApproval": "off"
  }
}
```

### `interactionModes.agentWriteApproval`

| Value | Behavior |
|-------|----------|
| `off` (default) | Workspace `write_file` / `patch` in agent mode follow normal policy (usually no approval) |
| `on` | Agent-mode workspace file writes require approval (Claude Code–like) |
| `acceptEditsOnly` | Same as `on` for agent; `acceptEdits` still auto-allows file writes |

## Manual regression checklist (`talon-test`)

1. **agent** + 「给重构建议」→ text-only answer, no auto mode switch, no forced writes
2. **plan** (via `/mode plan` or Shift+Tab) + same prompt → read-only tools only
3. **acceptEdits** + 「修复 xxx」→ file writes without approval; shell still prompts
4. `agentWriteApproval: "on"` + **agent** + file write → approval prompt

## What Talon deliberately does not do

- No `isAnalysisOnlyIntent()` or similar prompt heuristics to switch modes (Claude Code and Codex do not do this either)
- No post-completion guard that forces file writes when the model answers in text
