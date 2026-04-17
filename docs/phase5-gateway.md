# Phase 5 Gateway / Adapter

Phase 5 introduces a dedicated Gateway / Adapter layer so external entrypoints can join the system without leaking platform concerns into the execution kernel, memory plane, policy plane, tool orchestrator, or repositories.

## Goals

- keep Runtime Core platform-agnostic
- make adapter capability differences explicit
- preserve task, trace, and audit correlation for external requests
- leave extension seams for Slack, Telegram, Discord, MCP, webhook, SDK, remote bridge, and teammate-style multi-entry collaboration

## Architecture

```text
External Client / Platform
        |
        v
Inbound Adapter (protocol only)
  - HTTP / webhook
  - SDK / local API
  - future chat platforms
        |
        v
Gateway Runtime Facade
  - capability declaration + downgrade notices
  - identity mapping
  - session mapping
  - request -> runtime API translation
  - trace / audit source stamping
        |
        v
Application Service
        |
        v
Execution Kernel
  + Tool Orchestrator
  + Memory Plane
  + Policy Plane
  + Repositories
```

## Boundary Rules

Adapters are intentionally thin:

- adapters do not read or write memory directly
- adapters do not perform policy decisions
- adapters do not invoke tools directly
- adapters do not access repositories directly
- adapters only enter the system through `GatewayRuntimeApi`

Gateway owns:

- adapter capability declaration
- protocol-to-runtime request translation
- external identity to runtime identity mapping
- external session to task mapping
- source attribution into trace and audit
- graceful capability downgrade notices

Runtime owns:

- task execution
- tool execution and governance
- memory writes and recall
- policy enforcement
- persistence

## Capability Model

Each adapter must explicitly declare:

- `textInteraction`
- `approvalInteraction`
- `fileCapability`
- `streamingCapability`
- `structuredCardCapability`

The runtime does not assume all adapters support the same surface.

Examples:

- no `streamingCapability`: return buffered task state and let the caller poll or fetch history later
- no `approvalInteraction`: leave the task in `waiting_approval` and return approval metadata
- no `structuredCardCapability`: return plain JSON / text summaries
- no `fileCapability`: return artifact references rather than inline transport

Downgrades are never silent. They are recorded in both trace and audit.

## Minimal External Entrypoint

Phase 5 ships a local webhook adapter instead of a full chat-platform rollout.

Why this MVP:

- it validates the boundary without dragging platform SDK concerns into core code
- it gives us a real external transport for task submission and event retrieval
- it keeps the surface small enough to test thoroughly before adding platform adapters

Endpoints:

- `POST /tasks`
  - submit a task request
- `GET /tasks/:taskId`
  - fetch task result, notices, trace, audit, and adapter source
- `GET /tasks/:taskId/events`
  - fetch SSE event history and subscribe when the task is still live

## Identity And Session Mapping

Phase 5 adds repository-backed session binding records:

- `adapterId`
- `externalSessionId`
- `externalUserId`
- `runtimeUserId`
- `taskId`
- `metadata`

This keeps external identity/session mapping governed and queryable without granting adapters direct storage access.

## Trace And Audit Source Attribution

Every gateway-submitted task records:

- trace event: `gateway_request_received`
- trace event: `gateway_capability_degraded` when fallback happens
- audit action: `gateway_request`
- audit action: `gateway_capability_degraded` when fallback happens

That makes the entry source visible when reconstructing or auditing a task.

## Why Not Full Slack / Telegram / MCP Yet

Phase 5 does not directly implement Slack, Telegram, Discord, or MCP integrations because:

- the architecture boundary is the risky part, not the transport count
- platform APIs add approval UX, retry, webhook signature, rate limit, and formatting complexity
- shipping one local adapter first keeps the runtime contract honest before multiplying adapters

## Future Extension Seams

Planned extension directions now have explicit adapter slots:

- Slack / Telegram / Discord inbound adapters
- local SDK / remote SDK adapters
- webhook variants with signature validation
- MCP client / MCP server adapters
- remote bridge connectors
- teammate / multi-agent collaboration entry adapters

These future adapters should reuse the same Gateway runtime facade and capability model rather than bypassing it.
