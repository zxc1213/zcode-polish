/*
MCP server 契约测试（零依赖）：
node test/server.test.mjs
覆盖：握手、工具清单、面板资源、sampling 改写、地址校验（拒绝本机/内网）、配置不回传 Key、历史记录。
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "polish-test-"));

const child = spawn(process.execPath, [path.join(ROOT, "mcp", "server.mjs")], {
  env: { ...process.env, ZCODE_PLUGIN_DATA: dataDir },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;
const serverRequests = [];

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && !message.method) {
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); entry.resolve(message); }
      continue;
    }
    if (message.method) {
      serverRequests.push(message);
      // 模拟宿主：回复 sampling
      if (message.method === "sampling/createMessage") {
        child.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { role: "assistant", content: { type: "text", text: "改写结果 SAMPLING_OK" }, model: "host-model" },
        }) + "\n");
      }
    }
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`超时：${method}`)); }, 20000);
    pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ok   ${name}\n`); }
  catch (error) { failed++; process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`); }
}

const tool = async (name, args) => {
  const message = await call("tools/call", { name, arguments: args || {} });
  return message.result;
};

try {
  await test("握手返回协议版本与能力", async () => {
    const { result } = await call("initialize", {
      protocolVersion: "2026-01-26",
      capabilities: { sampling: {} },
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(result.protocolVersion, "2026-01-26");
    assert.ok(result.capabilities.tools);
    assert.equal(result.serverInfo.name, "zcode-polish");
  });

  await test("工具清单含四个工具，开面板工具带 resourceUri", async () => {
    const { result } = await call("tools/list", {});
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["polish_config", "polish_history", "polish_open", "polish_transform"]);
    const open = result.tools.find((t) => t.name === "polish_open");
    assert.equal(open._meta.ui.resourceUri, "ui://zcode-polish/panel.html");
  });

  await test("面板资源可读取且是 mcp-app HTML", async () => {
    const { result } = await call("resources/read", { uri: "ui://zcode-polish/panel.html" });
    const content = result.contents[0];
    assert.equal(content.mimeType, "text/html;profile=mcp-app");
    assert.ok(content.text.includes("提示词润色"));
    assert.ok(content.text.includes("发送到会话"));
    assert.ok(!content.text.includes("<script src="), "面板必须自包含，不能引用外部脚本");
  });

  await test("有 sampling 能力时改写走宿主模型", async () => {
    const result = await tool("polish_transform", { text: "帮我看看登录页", action: "enhance" });
    assert.ok(!result.isError, JSON.stringify(result).slice(0, 200));
    assert.equal(result.structuredContent.text, "改写结果 SAMPLING_OK");
    assert.equal(result.structuredContent.via, "sampling");
    const sampling = serverRequests.find((r) => r.method === "sampling/createMessage");
    assert.ok(sampling, "没有发出 sampling 请求");
    assert.ok(sampling.params.messages[0].content.text.includes("登录页"));
    assert.ok(sampling.params.messages[0].content.text.includes("输出纪律"));
  });

  await test("拒绝本机与内网地址", async () => {
    for (const bad of ["http://127.0.0.1:8080/v1", "http://localhost:1234", "http://192.168.1.5", "http://169.254.169.254", "ftp://a.com"]) {
      const result = await tool("polish_config", { baseUrl: bad });
      assert.equal(result.isError, true, `应当拒绝 ${bad}`);
      assert.ok(/拒绝|仅支持/.test(result.content[0].text), `错误信息应说明原因：${result.content[0].text}`);
    }
  });

  await test("配置保存后不回传 apiKey", async () => {
    const result = await tool("polish_config", { baseUrl: "https://open.bigmodel.cn/api/anthropic", model: "GLM-5.2", protocol: "anthropic", apiKey: "sk-test-secret" });
    assert.ok(!result.isError, JSON.stringify(result));
    const cfg = result.structuredContent;
    assert.equal(cfg.ready, true);
    assert.equal(cfg.apiKeySet, true);
    assert.equal(cfg.apiKey, undefined);
    assert.ok(!JSON.stringify(result).includes("sk-test-secret"), "apiKey 泄漏到了返回内容");
  });

  await test("空草稿报错而不是瞎猜", async () => {
    const result = await tool("polish_transform", { text: "   " });
    assert.equal(result.isError, true);
    assert.ok(/草稿为空/.test(result.content[0].text));
  });

  await test("历史记录累积", async () => {
    const result = await tool("polish_history", {});
    const items = result.structuredContent.items;
    assert.ok(items.length >= 1);
    assert.equal(items[0].action, "enhance");
    assert.equal(items[0].via, "sampling");
  });
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
