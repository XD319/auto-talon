# Tentaclaw Phase 2

Tentaclaw is an Agent Runtime MVP focused on a CLI-first, governance-friendly execution kernel. Phase 2 extends the Phase 1 runtime with a policy plane, approval flow, sandbox enforcement, audit logging, and profile-aware execution without introducing a web UI or framework-heavy agent stack.

## Phase 2 Capabilities

- TypeScript strict-mode Node.js runtime with a thin CLI entry.
- Single-agent execution kernel with provider abstraction and a built-in `MockProvider`.
- Shared runtime skeleton for `planner`, `executor`, and `reviewer` profiles.
- Structured tool orchestration for:
  - `file_read`: read file, list directory, keyword search
  - `file_write`: write file, update file, simplified patch application
  - `shell`: restricted shell execution with workspace/cwd/env/timeout boundaries
  - `web_fetch`: allowlisted HTTP fetch through the sandbox
- Policy plane with typed `allow`, `allow_with_approval`, and `deny` decisions.
- Approval flow with persisted pending approvals, reviewer identity, timestamps, and timeouts.
- SQLite persistence for tasks, traces, tool calls, approvals, audit logs, artifacts, checkpoints, and run metadata.
- Separate trace and audit views so execution reconstruction and governance inspection stay distinct.

## Project Layout

```text
src/
  approvals/
  audit/
  agents/
  cli/
  memory/
  policy/
  profiles/
  runtime/
  sandbox/
  storage/
  tools/
  tracing/
  types/
test/
docs/
```

## Install

```bash
corepack pnpm install
```

## CLI Usage

```bash
corepack pnpm dev run "write notes.txt :: hello" --profile executor
corepack pnpm dev task list
corepack pnpm dev task show <task_id>
corepack pnpm dev trace <task_id>
corepack pnpm dev audit <task_id>
corepack pnpm dev approve pending
corepack pnpm dev approve allow <approval_id>
corepack pnpm dev approve deny <approval_id>
corepack pnpm dev config doctor
```

After building, the compiled CLI entry is `dist/cli/index.js` and the binary name is `agent`.

## Runtime Flow

1. CLI parses arguments and delegates to the application service.
2. The execution kernel creates a persisted task and run metadata record.
3. The selected agent profile contributes its prompt and tool whitelist.
4. Provider input is assembled from task context, memory context, tool catalog, and token-budget placeholders.
5. Tool calls are executed only through the orchestrator, which:
   - validates input,
   - prepares a sandboxed execution plan,
   - evaluates policy,
   - requests approval when needed,
   - persists tool-call state,
   - records trace and audit events.
6. If approval is needed, the task moves to `waiting_approval`, a checkpoint is stored, and the CLI can later resume the task through `agent approve allow <approval_id>`.
7. Tool outputs are fed back into the provider loop until the task succeeds, fails, times out, or is rejected.

## Policy Rules

Phase 2 uses a local rule configuration through `src/policy/default-policy-config.ts`. Each rule has:

- `id`
- `description`
- `priority`
- `effect`
- `match`

Supported match fields:

- `users`
- `workspaces`
- `agentProfiles`
- `toolNames`
- `capabilities`
- `riskLevels`
- `privacyLevels`
- `pathScopes`

Current defaults:

- deny any tool request that escapes workspace boundaries
- deny `reviewer` writes and shell execution
- require approval for `filesystem.write`, `shell.execute`, and `network.fetch`
- allow workspace-scoped `filesystem.read`

## Approval Flow

Approval state is stored separately from tool calls and includes:

- requester id
- reviewer id
- request time
- decision time
- timeout
- decision result

Task and tool-call state expectations:

- task enters `waiting_approval` while a gated action is pending
- tool call enters `awaiting_approval`
- approval allow resumes the kernel from a persisted checkpoint
- approval deny or timeout fails the task and marks the tool call as `denied` or `timed_out`

CLI control surface:

- `agent approve pending`
- `agent approve allow <approval_id>`
- `agent approve deny <approval_id>`

## Audit Log vs Trace

Trace is for replaying task execution. It captures the ordered decision chain of a run, including provider calls, policy decisions, approval events, sandbox outcomes, and tool execution milestones.

Audit log is for governance inspection. It captures policy decisions, high-risk requests, approvals, sandbox enforcement, file writes, shell execution, web fetches, and rejection/failure events in a compliance-oriented view.

Use:

- `agent trace <task_id>` for execution reconstruction
- `agent audit <task_id>` for governance/audit inspection

## Reviewer Profile

`reviewer` shares the same runtime kernel as other profiles but is intentionally constrained:

- prompt is review-focused
- tool whitelist is read-oriented
- policy denies write and shell capabilities

This keeps reviewer behavior controlled without introducing multi-agent swarm logic.

## Additional Notes

- The runtime still uses Node's experimental `node:sqlite` module to keep SQL inside repository boundaries.
- `web_fetch` is sandboxed behind an allowlist and defaults to `example.com` in the bootstrap config for the MVP.
- Approval TTL defaults to 5 minutes and is configurable through bootstrap config.
- See [docs/phase2-governance.md](/D:/Backup/Career/Projects/AgentProject/tentaclaw/docs/phase2-governance.md) for the Phase 2 governance notes.

## Development Commands

```bash
corepack pnpm install
./node_modules/.bin/tsc.cmd -p tsconfig.json
./node_modules/.bin/vitest.cmd run
./node_modules/.bin/eslint.cmd .
```
