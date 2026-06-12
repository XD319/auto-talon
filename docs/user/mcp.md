# MCP

Client config: `.auto-talon/mcp.config.json`

Supported client transports:

- `stdio`: local MCP servers launched by command.
- `streamable_http`: remote JSON-RPC MCP servers reached by URL.

AutoTalon intentionally does not support SSE, WebSocket, OAuth callback flows,
HTTP hooks, agent hooks, or MCP Apps UI in this release. Remote authentication
uses explicit headers, environment-backed headers, or bearer tokens read from an
environment variable.

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

MCP tools are normally discovered through `mcp_tool_search`. Matching tools are
made available for the next model turn. Set `alwaysLoad: true` on a server only
when all of its tools should be exposed at startup.

MCP resources and prompts are available through:

- `mcp_resource` to read `resources/list` / `resources/read` entries.
- `mcp_prompt` to load `prompts/list` / `prompts/get` templates.

Use `.auto-talon/tool-overrides.json` to disable specific tools (including MCP adapters) without changing MCP server config.

Example HTTP server:

```json
{
  "version": 2,
  "servers": [
    {
      "id": "docs",
      "type": "streamable_http",
      "url": "https://example.internal/mcp",
      "bearerTokenEnvVar": "DOCS_MCP_TOKEN",
      "alwaysLoad": false,
      "enabledTools": ["search"],
      "disabledTools": []
    }
  ]
}
```
