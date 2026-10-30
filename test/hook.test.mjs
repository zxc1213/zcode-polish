/*
polish-hook 闸门行为测试：核心保证是「未命中 = 透传（stdout 恰为 "{}"）」。
node:test + 子进程跑真实 hook 脚本；mock 模型服务返回固定润色结果。
*/
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";

const HOOK = path.resolve(import.meta.dirname, "../hooks/polish-hook.mjs");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "polish-hook-test-"));
let server;
let port;

function writeConfig(hook) {
  const cfg = { baseUrl: `http://127.0.0.1:${port}`, model: "mock-model", apiKey: "k", protocol: "chat" };
  if (hook !== undefined) cfg.hook = hook;
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg));
}

function runHook(prompt, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, ZCODE_PLUGIN_DATA: dataDir },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ out, err, code }));
    child.stdin.end(JSON.stringify({ prompt, ...extra }));
  });
}

test.after(() => { server?.close(); });

test("setup: mock 模型服务", async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.includes("fail")) return res.writeHead(500).end(JSON.stringify({ error: { message: "boom" } }));
      res.writeHead(200).end(JSON.stringify({ choices: [{ message: { content: "增强版草稿内容" } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
  port = server.address().port;
  writeConfig(undefined);
});

test("默认（未开启 hook）→ 透传", async () => {
  const r = await runHook("pp 帮我写个分页组件");
  assert.equal(r.out, "{}");
});

test("开启但无前缀 → 透传", async () => {
  writeConfig({ enabled: true });
  const r = await runHook("帮我写个分页组件");
  assert.equal(r.out, "{}");
});

test("斜杠命令 → 永远透传", async () => {
  const r = await runHook("/polish 帮我写个分页组件");
  assert.equal(r.out, "{}");
});

test("前缀命中但内容过短 → 透传", async () => {
  const r = await runHook("pp hi");
  assert.equal(r.out, "{}");
});

test("前缀命中 → 注入增强版 additionalContext", async () => {
  const r = await runHook("pp 帮我写一个分页组件，要求支持服务端分页");
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.ok(parsed.additionalContext.includes("<enhanced-prompt>"));
  assert.ok(parsed.additionalContext.includes("增强版草稿内容"));
  assert.ok(!parsed.additionalContext.includes("apiKey"));
});
