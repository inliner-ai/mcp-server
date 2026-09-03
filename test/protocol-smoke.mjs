import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const generationBodies = [];
const fakeApi = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/account/plan-usage") {
    res.end(JSON.stringify([{ feature: "IMAGE", remaining: 42 }]));
    return;
  }
  if (req.url === "/content/generate" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      generationBodies.push(parsed);
      res.end(JSON.stringify({
        prompt: `${parsed.project}/${parsed.slug}.${parsed.extension}`,
        mediaAsset: { data: "data:image/png;base64,aGVsbG8=" },
      }));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise((resolve) => fakeApi.listen(0, "127.0.0.1", resolve));
const address = fakeApi.address();
assert(address && typeof address === "object");

const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    INLINER_API_KEY: "inl_protocol_smoke_test_only",
    INLINER_API_URL: `http://127.0.0.1:${address.port}`,
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
  assert.equal(initialized.result.serverInfo.version, "1.3.0");
  assert.match(initialized.result.instructions, /call generate_image/);
  assert.match(initialized.result.instructions, /recommend_image_url/);
  assert.match(initialized.result.instructions, /mode=cheap/);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  const listed = await waitFor(2);
  const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  assert(tools.has("generate_image"));
  assert(tools.has("edit_image"));
  assert(tools.has("recommend_image_url"));
  assert.match(tools.get("generate_image_url").description, /Deprecated/);
  assert.match(tools.get("create_image").description, /Deprecated/);
  assert.deepEqual(tools.get("generate_image").inputSchema.properties.mode.enum, ["auto", "cheap"]);
  assert(tools.get("generate_image").inputSchema.properties.model.enum.includes("IMAGE_GEN_Z_IMAGE_TURBO"));
  assert(tools.get("generate_image").inputSchema.properties.model.enum.includes("IMAGE_GEN_QWEN_IMAGE"));
  assert(tools.get("generate_image").inputSchema.properties.model.enum.includes("IMAGE_GEN_NANO_BANANA_LITE"));
  assert(tools.get("generate_image").inputSchema.properties.model.enum.includes("IMAGE_GEN_GROK_IMAGINE_2"));

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

  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "get_usage", arguments: {} },
  });

  const usage = await waitFor(4);
  assert.deepEqual(usage.result.structuredContent.data, [
    { feature: "IMAGE", remaining: 42 },
  ]);

  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "generate_image",
      arguments: {
        project: "demo",
        description: "budget-office-team",
        width: 1200,
        height: 800,
        format: "png",
        smartUrl: false,
        mode: "cheap",
        model: "IMAGE_GEN_QWEN_IMAGE",
      },
    },
  });

  const generated = await waitFor(5);
  assert.equal(generated.result.structuredContent.generated, true);
  assert.equal(generated.result.structuredContent.mode, "cheap");
  assert.equal(generated.result.structuredContent.model, "IMAGE_GEN_QWEN_IMAGE");
  assert.equal(generationBodies.length, 1);
  assert.equal(generationBodies[0].mode, "cheap");
  assert.equal(generationBodies[0].model, "IMAGE_GEN_QWEN_IMAGE");

  console.log(`Protocol smoke test passed with ${tools.size} tools.`);
} finally {
  lines.close();
  server.kill();
  await new Promise((resolve) => fakeApi.close(resolve));
}
