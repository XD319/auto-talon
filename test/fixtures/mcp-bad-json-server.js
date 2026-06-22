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
          serverInfo: { name: "bad-json-mcp", version: "1.0.0" }
        }
      })}\n`
    );
    return;
  }

  if (message.method === "tools/list") {
    process.stdout.write("{not valid json\n");
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
