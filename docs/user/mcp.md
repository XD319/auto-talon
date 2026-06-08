# MCP

Client config: `.auto-talon/mcp.config.json`

Basic commands:

- `talon mcp list`
- `talon mcp ping <server_id>`

Serve this runtime as an MCP server:

```bash
talon mcp serve --transport stdio
```

Server config: `.auto-talon/mcp-server.config.json`

## MCP tools in the runtime

MCP tools are adapted into the runtime `ToolDefinition` surface with metadata only:

- `riskLevel`, `costLevel`, `sideEffectLevel`, `toolKind`
- Governance at execution time uses policy, sandbox checks, and approval flow — not static approval defaults on the tool record.

Registered MCP tools use the `mcp__<server_id>__<tool_name>` naming convention and appear in `talon tools list` alongside built-in tools.

Use `.auto-talon/tool-overrides.json` to disable specific tools (including MCP adapters) without changing MCP server config.
