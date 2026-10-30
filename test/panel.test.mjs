/*
面板渲染与交互测试（零依赖）：
node test/panel.test.mjs
用本地静态服务 + Edge 无头把 ui/panel.html 放进 iframe，由 harness 扮演宿主应答 JSON-RPC，
验证：握手、配置读取、动作按钮、改写回填、发送到会话。不需要启动真实 ZCode。
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

if (!EDGE) {
  process.stdout.write("跳过面板测试：本机没有 Edge\n");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "polish-panel-"));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const map = {
    "/": path.join(ROOT, "test", "panel-harness.html"),
    "/ui/panel.html": path.join(ROOT, "ui", "panel.html"),
  };
  const file = map[url.pathname];
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(file));
});

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

class Client {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.errors = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener("open", resolve);
      this.ws.addEventListener("error", () => reject(new Error("CDP 连接失败")));
      this.ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message)); else entry.resolve(msg.result);
        } else if (msg.method === "Runtime.exceptionThrown") {
          this.errors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text);
        }
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send("Runtime.enable", {}, sessionId);
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  async waitFor(expression, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await this.evaluate(expression)) return true; } catch {}
      await sleep(120);
    }
    throw new Error(`等待超时：${label}`);
  }
  close() { try { this.ws?.close(); } catch {} }
}

const cleanup = [];
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ok   ${name}\n`); }
  catch (error) { failed++; process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`); }
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const webPort = server.address().port;
  cleanup.push(() => new Promise((r) => server.close(r)));

  const debugPort = await freePort();
  const edge = spawn(EDGE, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu",
    `http://127.0.0.1:${webPort}/`,
  ], { stdio: "ignore" });
  cleanup.push(() => spawnSync("taskkill.exe", ["/PID", String(edge.pid), "/T", "/F"], { windowsHide: true }));

  let target = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
      target = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
    } catch {}
    if (!target) await sleep(200);
  }
  assert.ok(target, "页面没有打开");
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  const client = new Client(version.webSocketDebuggerUrl);
  await client.connect();
  await client.attach(target.id);
  cleanup.push(() => client.close());

  const frame = `document.getElementById('app').contentDocument`;

  process.stdout.write("面板（Edge + MCP Apps 协议）\n");

  await test("面板完成握手并加载配置", async () => {
    await client.waitFor(`${frame}.getElementById('draft')`, 10000, "面板未渲染");
    await client.waitFor(`window.hostLog.includes('ui/initialize')`, 5000, "没有发出 ui/initialize");
    await client.waitFor(`${frame}.getElementById('meta') && ${frame}.getElementById('status').textContent.includes('就绪')`, 8000, "配置未读取");
  });

  await test("五个动作按钮渲染出来", async () => {
    const labels = await client.evaluate(`[...${frame}.querySelectorAll('.chip')].map(n => n.textContent)`);
    assert.deepEqual(labels, ["增强", "精简", "结构化", "中英互译", "纠错"]);
  });

  await test("点动作→调用工具→回填结果", async () => {
    await client.evaluate(`(() => {
      const input = ${frame}.getElementById('draft');
      input.value = '帮我看看登录页';
      ${frame}.querySelector('.chip[data-action="concise"]').click();
    })()`);
    await client.waitFor(`${frame}.getElementById('result').textContent.includes('PANEL_OK')`, 8000, "结果未回填");
    const sent = await client.evaluate(`JSON.stringify(window.lastTransform)`);
    const args = JSON.parse(sent);
    assert.equal(args.action, "concise");
    assert.equal(args.text, "帮我看看登录页");
    const meta = await client.evaluate(`${frame}.getElementById('meta').textContent`);
    assert.ok(meta.includes("samping") || meta.includes("宿主模型"), `耗时标签缺失：${meta}`);
  });

  await test("发送到会话走 ui/message", async () => {
    await client.evaluate(`${frame}.getElementById('send').click()`);
    await client.waitFor(`Boolean(window.lastMessage)`, 5000, "没有发出 ui/message");
    const message = JSON.parse(await client.evaluate(`JSON.stringify(window.lastMessage)`));
    assert.equal(message.role, "user");
    assert.ok(message.content[0].text.includes("PANEL_OK"));
  });

  await test("空草稿不发请求", async () => {
    await client.evaluate(`(() => {
      ${frame}.getElementById('draft').value = '   ';
      window.lastTransform = null;
      ${frame}.querySelector('.chip[data-action="enhance"]').click();
    })()`);
    await sleep(400);
    const last = await client.evaluate(`window.lastTransform`);
    assert.equal(last, null, "空草稿不应该发起调用");
    const status = await client.evaluate(`${frame}.getElementById('status').textContent`);
    assert.ok(status.includes("先"), `状态应提示先输入：${status}`);
  });

  await test("面板无未捕获异常", async () => {
    assert.deepEqual(client.errors, []);
  });
} catch (error) {
  process.stdout.write(`\n失败：${error.message}\n`);
  failed++;
} finally {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch {} }
  await sleep(400);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
