#!/usr/bin/env node
/*
ZCode Polish MCP server（stdio，按行分隔的 JSON-RPC 2.0，零依赖）。
职责：
1. 提供右侧面板资源（ui://zcode-polish/panel.html）
2. 提供改写工具：polish_transform / polish_config / polish_history / polish_open
3. 有 sampling 能力时借用宿主模型，没有就用面板里配置的接口
stdout 只走协议，日志一律写 stderr。
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTIONS, PLUGIN_DATA, VERSION, callModel, loadConfig, publicConfig, renderPrompt, saveConfig,
} from "./lib.mjs";

const PANEL_URI = "ui://zcode-polish/panel.html";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_FILE = path.join(HERE, "..", "ui", "panel.html");
const HISTORY_FILE = path.join(PLUGIN_DATA, "history.json");

const log = (...parts) => process.stderr.write(`[polish] ${parts.join(" ")}\n`);

let clientCaps = {};
let nextServerId = 1e6;
const pending = new Map();

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function reply(id, result) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// 服务端 → 客户端的请求（sampling 等）
function requestClient(method, params, timeoutMs = 90000) {
  const id = nextServerId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("宿主没有响应 sampling 请求"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function history() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { return []; }
}
function pushHistory(entry) {
  const list = [entry, ...history()].slice(0, 12);
  try {
    fs.mkdirSync(PLUGIN_DATA, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch {}
  return list;
}

function panelHtml() {
  return fs.readFileSync(PANEL_FILE, "utf8");
}

async function usingSampling() {
  return Boolean(clientCaps?.sampling);
}

async function transformViaSampling(prompt) {
  const result = await requestClient("sampling/createMessage", {
    messages: [{ role: "user", content: { type: "text", text: `${prompt.system}\n\n${prompt.user}` } }],
    maxTokens: 4096,
    systemPrompt: prompt.system,
  });
  const content = result?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.map((c) => c?.text || "").join("")
    : content?.text || "";
  if (!String(text).trim()) throw new Error("宿主模型返回为空");
  return String(text).trim();
}

async function transform(text, action) {
  const started = Date.now();
  const prompt = renderPrompt(action, text);
  let output;
  let via;
  if (await usingSampling()) {
    try {
      output = await transformViaSampling(prompt);
      via = "sampling";
    } catch (error) {
      log("sampling 失败，改用面板配置的接口:", error.message);
    }
  }
  if (!output) {
    const cfg = loadConfig();
    if (!publicConfig(cfg).ready) {
      throw new Error("还没有配置模型接口：点面板右上角「设置」填 Base URL / 模型 / API Key，或把宿主的 sampling 能力打开");
    }
    output = await callModel(cfg, prompt);
    via = "config";
  }
  const ms = Date.now() - started;
  pushHistory({ at: new Date().toISOString(), action, via, ms, chars: output.length });
  return { text: output, action, via, ms };
}

const TOOLS = [
  {
    name: "polish_open",
    description: "打开提示词润色面板：在面板里输入草稿、选动作、看结果，再把结果发到会话。",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: PANEL_URI }, "ui/resourceUri": PANEL_URI },
  },
  {
    name: "polish_transform",
    description: "把提示词草稿改写成清晰可执行的版本。action 取 enhance/concise/structure/english/proofread，默认 enhance。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "待改写的草稿" },
        action: { type: "string", enum: Object.keys(ACTIONS), description: "动作，默认 enhance" },
      },
      required: ["text"],
    },
  },
  {
    name: "polish_config",
    description: "查看或修改润色用的模型接口配置。只传要改的字段；apiKey 不会回传。",
    inputSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", description: "公网 http(s) 地址" },
        model: { type: "string" },
        protocol: { type: "string", enum: ["anthropic", "chat", "responses"] },
        apiKey: { type: "string" },
        clearApiKey: { type: "boolean" },
      },
    },
  },
  {
    name: "polish_history",
    description: "最近 12 次改写的记录（动作、耗时、来源、字数）。",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name, args = {}) {
  if (name === "polish_open") {
    return { content: [{ type: "text", text: "面板已就绪：在右侧「提示词润色」里输入草稿即可。" }] };
  }
  if (name === "polish_transform") {
    const result = await transform(args.text, args.action || "enhance");
    return {
      content: [{ type: "text", text: result.text }],
      structuredContent: result,
    };
  }
  if (name === "polish_config") {
    const patch = {};
    for (const key of ["baseUrl", "model", "protocol", "apiKey"]) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    if (args.clearApiKey === true) patch.clearApiKey = true;
    const changed = Object.keys(patch).length > 0;
    const cfg = changed ? saveConfig(patch) : publicConfig(loadConfig());
    return { content: [{ type: "text", text: JSON.stringify(cfg, null, 2) }], structuredContent: cfg };
  }
  if (name === "polish_history") {
    return { content: [{ type: "text", text: JSON.stringify(history(), null, 2) }], structuredContent: { items: history() } };
  }
  throw new Error(`未知工具：${name}`);
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      clientCaps = params?.capabilities || {};
      reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "zcode-polish", version: VERSION },
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      try {
        reply(id, await callTool(name, params?.arguments || {}));
      } catch (error) {
        reply(id, { isError: true, content: [{ type: "text", text: String(error?.message || error) }] });
      }
      return;
    }
    case "resources/list":
      reply(id, {
        resources: [{
          uri: PANEL_URI,
          name: "提示词润色面板",
          mimeType: "text/html;profile=mcp-app",
        }],
      });
      return;
    case "resources/templates/list":
      reply(id, { resourceTemplates: [] });
      return;
    case "resources/read":
      if (params?.uri !== PANEL_URI) throw new Error(`未知资源：${params?.uri}`);
      reply(id, { contents: [{ uri: PANEL_URI, mimeType: "text/html;profile=mcp-app", text: panelHtml() }] });
      return;
    case "prompts/list":
      reply(id, { prompts: [] });
      return;
    default:
      if (id !== undefined && id !== null) replyError(id, -32601, `不支持的方法：${method}`);
  }
}

function onLine(line) {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch { log("收到非 JSON 数据，已忽略"); return; }

  // 客户端对服务端请求的响应
  if (!message.method && message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message || "宿主返回错误"));
    else entry.resolve(message.result);
    return;
  }
  if (!message.method) return;

  Promise.resolve()
    .then(() => handle(message))
    .catch((error) => {
      log("处理失败:", error?.message || error);
      replyError(message.id, -32603, String(error?.message || error));
    });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    onLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("uncaughtException", (error) => log("未捕获异常:", error?.message || error));
