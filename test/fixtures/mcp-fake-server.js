/* global process */

process.stdin.setEncoding("utf8");

let buffer = "";

function handleMessage(message) {
  if (message.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        jsonrpc: "2.0",
        result: {
          capabilities: {},
          serverInfo: { name: "fake-mcp", version: "1.0.0" }
        }
      })}\n`
    );
    return;
  }

  if (message.method === "tools/list") {
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        jsonrpc: "2.0",
        result: {
          tools: [
            {
              description: "Echo input payload",
              inputSchema: {
                properties: {
                  text: { type: "string" }
                },
                required: ["text"],
                type: "object"
              },
              name: "echo"
            }
          ]
        }
      })}\n`
    );
    return;
  }

  if (message.method === "tools/call") {
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        jsonrpc: "2.0",
        result: {
          content: {
            echoed: message.params?.arguments ?? null
          }
        }
      })}\n`
    );
  }
}

function flushLines() {
  const lines = buffer
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  buffer = "";

  for (const line of lines) {
    handleMessage(JSON.parse(line));
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  flushLines();
});

process.stdin.on("end", () => {
  flushLines();
});
