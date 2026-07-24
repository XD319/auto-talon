# Desktop Companion (ADR)

Status: accepted for `v0.2.0` planning  
Date: 2026-07-24

## Context

AutoTalon’s daily surface today is the Ink-based terminal UI (`talon tui` /
`talon ops`). Users who want a graphical companion need a desktop shell that
still respects local-first governance. `v0.1.0` explicitly left companion apps
out of release scope. For `v0.2.0`, a **parallel** desktop-companion track runs
alongside measurement and cost work without replacing the TUI.

## Decision

Ship a **desktop companion** as:

| Layer | Choice |
| --- | --- |
| Shell | Tauri 2 |
| UI | Vite + React |
| Runtime | Existing Node `talon` process as a **sidecar** |
| Transport | Local `talon session-api serve` (Bearer auth) |

The companion **does not** re-implement the execution kernel, policy engine,
sandbox, or provider loop. It is a client of the same runtime used by CLI/TUI.

### Architecture

```text
Tauri shell (React UI)
  │  Bearer token over loopback HTTP
  ▼
talon session-api serve  ──► AgentApplicationService ──► ExecutionKernel
  ▲
spawn / health-check sidecar
```

Planned monorepo location: `apps/desktop/` (scaffold lands in M5a).

## Security boundaries (non-negotiable)

- Bind `session-api` to `127.0.0.1` by default. Do not expose to LAN/public hosts
  as a product feature.
- Authenticate with the existing HTTP token (`.auto-talon/http.token` or
  `AGENT_HTTP_TOKEN`). See `src/core/http-auth.ts`.
- Approvals and tool execution must go through the runtime PolicyEngine /
  approval path. The companion must never auto-allow high-risk actions locally
  or bypass sandbox policy.
- No multi-tenant or hosted companion service in this track.
- Companion PRs should not weaken `requireHttpAuth`, loopback checks, or
  approval semantics. Such changes are maintainer-only and out of claimable
  scope.

## Phases (M5)

| Phase | Goal | Ownership | v0.2.0 bar |
| --- | --- | --- | --- |
| M5a | Tauri + Vite scaffold, sidecar spawn, health check, token injection | maintainer → mixed | **required** |
| M5b | Read-only session browser / transcript (ops-aligned) | community | **required** |
| M5c | Approval queue + allow/deny via API | mixed | best-effort |
| M5d | Chat compose via `continue` / new session (non-streaming first) | mixed | stretch |
| M5e | Windows packaging + first-run workspace picker | mixed | stretch |

Measurement (M1) and cost (M2) remain the quality/cost headline. Missing M5d/M5e
must not block a measurement/cost-focused `v0.2.0` tag.

## API gaps

Already available on session-api: session list/detail/messages, search,
`POST .../continue`, model PATCH.

Still needed for the companion track:

- Read-only ops views (tasks, trace summaries, pending approvals, inbox signals)
- Approval allow/deny actions (scoped like TUI/ops)
- Health / readiness for sidecar lifecycle
- Optional later: streaming / long-task progress (SSE or equivalent)

## Bandwidth rules

- Prefer touching only `apps/desktop/**`, `src/session-api/**`, and docs.
- Avoid large TUI refactors in companion PRs.
- Core `npm run check` stays Node-focused. Desktop CI may be an optional job
  that skips when the Rust toolchain is absent (same pattern as paid eval).

## Non-goals (this track)

- Electron (heavier; not chosen)
- Mobile companion
- Public/remote dashboard
- Replacing `talon tui` as the only supported daily surface
- Rewriting the agent kernel inside the shell

## References

- [ROADMAP.md](../../ROADMAP.md) — M5
- Tracking issues: [#10](https://github.com/XD319/auto-talon/issues/10) (docs),
  [#11](https://github.com/XD319/auto-talon/issues/11) (scaffold),
  [#12](https://github.com/XD319/auto-talon/issues/12) (ops API),
  [#13](https://github.com/XD319/auto-talon/issues/13) (read-only UI),
  [#14](https://github.com/XD319/auto-talon/issues/14) (approvals),
  [#15](https://github.com/XD319/auto-talon/issues/15) (chat),
  [#16](https://github.com/XD319/auto-talon/issues/16) (Windows packaging)
- [Session HTTP API](session-api.md)
- [SECURITY.md](../../SECURITY.md)
- `src/session-api/server.ts`, `src/core/http-auth.ts`
