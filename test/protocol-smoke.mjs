import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    INLINER_API_KEY: "inl_protocol_smoke_test_only",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = new Map();
const stderr = [];
const lines = createInterface({ input: server.stdout });

server.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined) responses.set(message.id, message);
});

function send(message) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitFor(id, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (!responses.has(id)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for response ${id}. stderr: ${stderr.join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return responses.get(id);
}

try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "inliner-protocol-smoke", version: "1.0.0" },
    },
  });

  const initialized = await waitFor(1);
  assert.equal(initialized.result.serverInfo.name, "inliner");
  assert.equal(initialized.result.serverInfo.version, "1.1.0");
  assert.match(initialized.result.instructions, /call generate_image/);
  assert.match(initialized.result.instructions, /recommend_image_url/);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  const listed = await waitFor(2);
  const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  assert(tools.has("generate_image"));
  assert(tools.has("edit_image"));
  assert(tools.has("recommend_image_url"));
  assert.match(tools.get("generate_image_url").description, /Deprecated/);
  assert.match(tools.get("create_image").description, /Deprecated/);

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "recommend_image_url",
      arguments: {
        project: "demo",
        description: "modern-office-team-meeting",
        width: 1200,
        height: 600,
        format: "jpg",
        smartUrl: false,
      },
    },
  });

  const recommended = await waitFor(3);
  assert.equal(recommended.result.structuredContent.generated, false);
  assert.equal(recommended.result.structuredContent.project, "demo");
  assert.match(recommended.result.structuredContent.warning, /Call generate_image/);

  console.log(`Protocol smoke test passed with ${tools.size} tools.`);
} finally {
  lines.close();
  server.kill();
}
