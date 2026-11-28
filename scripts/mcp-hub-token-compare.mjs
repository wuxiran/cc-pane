#!/usr/bin/env node
// 估算 agent 启动时共享 MCP 工具定义占多少上下文，三种口径并列（docs/113）：
//   1. 全量注入：每个工具的 {name, description, inputSchema} 紧凑 JSON（Codex 等没有原生延迟加载的 CLI）。
//   2. Claude 原生延迟加载（MCP tool search）：启动只看到工具名（`mcp__<server>__<tool>`），schema 用到才取。
//      这里按「工具名列表」估下限；实际开不开、阈值多少取决于 Claude Code 版本与设置。
//   3. 只注入 hub：hub_tools.json 两个工具 + handler 的 instructions（sse 服务器仍直连，按全量计入）。
//
// 只发 initialize + tools/list，不调用任何工具。token ≈ 字节 / 4（JSON + 英文为主时的常用近似，
// 中文描述会偏低估）。hub 的代价在使用时：每次 search_tools 返回命中工具的完整 schema。
//
// 用法：
//   node scripts/mcp-hub-token-compare.mjs                       # 读 ~/.cc-panes/shared-mcp.json 里已启用的服务器
//   node scripts/mcp-hub-token-compare.mjs --data-dir ~/.cc-panes-dev
//   node scripts/mcp-hub-token-compare.mjs --url fetch=http://127.0.0.1:3100/mcp [--url ...]
//   加 --json 输出机器可读结果。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUB_TOOLS = join(repoRoot, "cc-panes-core/src/services/mcp_hub/hub_tools.json");
const HUB_HANDLER = join(repoRoot, "src-tauri/src/services/mcp_hub_handler.rs");
const TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const args = { urls: [], dataDir: join(homedir(), ".cc-panes"), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") {
      const [name, ...rest] = (argv[++i] ?? "").split("=");
      args.urls.push({ name, url: rest.join("="), headers: {} });
    } else if (arg === "--data-dir") {
      args.dataDir = argv[++i].replace(/^~/, homedir());
    } else if (arg === "--json") {
      args.json = true;
    }
  }
  return args;
}

/** shared-mcp.json → 本该逐个注入的服务器（shared=true；sse 远程 hub 不代转，单列）。 */
function targetsFromConfig(dataDir) {
  const config = JSON.parse(readFileSync(join(dataDir, "shared-mcp.json"), "utf8"));
  return Object.entries(config.servers ?? {})
    .filter(([, server]) => server.shared !== false)
    .map(([name, server]) => {
      if (server.remote) {
        return {
          name,
          url: server.remote.url,
          headers: server.remote.headers ?? {},
          sse: (server.remote.transport ?? "http").toLowerCase() === "sse",
        };
      }
      return { name, url: `http://127.0.0.1:${server.port}/mcp`, headers: {} };
    });
}

function pickResponse(text, id) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const value = JSON.parse(trimmed);
    return Array.isArray(value) ? value.find((v) => v.id === id) : value;
  }
  for (const event of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const value = JSON.parse(data);
      if (value.id === id) return value;
    } catch {
      // 非 JSON 的 data 行跳过
    }
  }
  throw new Error("no matching JSON-RPC response");
}

async function listTools({ url, headers }) {
  let session = null;
  let nextId = 1;
  const post = async (message) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-03-26",
        ...(session ? { "Mcp-Session-Id": session } : {}),
        ...headers,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    session ??= response.headers.get("mcp-session-id");
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
    return text;
  };
  const request = async (method, params) => {
    const id = nextId++;
    const envelope = pickResponse(await post({ jsonrpc: "2.0", id, method, params }), id);
    if (envelope.error) throw new Error(`${method}: ${JSON.stringify(envelope.error)}`);
    return envelope.result;
  };
  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-hub-token-compare", version: "1" },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = [];
  let cursor;
  for (let page = 0; page < 50; page += 1) {
    const result = await request("tools/list", cursor ? { cursor } : {});
    tools.push(...(result.tools ?? []));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** 模型看到的部分：name + description + inputSchema（annotations 等元数据不计）。 */
function definitionBytes(tools) {
  const visible = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return Buffer.byteLength(JSON.stringify(visible), "utf8");
}

/** Claude 延迟加载时启动可见的部分：按 `mcp__<server>__<tool>` 一行一个估算。 */
function namesBytes(server, tools) {
  return tools.reduce((sum, tool) => sum + Buffer.byteLength(`mcp__${server}__${tool.name}\n`, "utf8"), 0);
}

function hubBytes() {
  const tools = JSON.parse(readFileSync(HUB_TOOLS, "utf8"));
  const handler = readFileSync(HUB_HANDLER, "utf8");
  const match = handler.match(/with_instructions\(\s*"([^"]*)"/);
  const instructions = match ? match[1] : "";
  return {
    tools: tools.length,
    toolBytes: definitionBytes(tools),
    instructionBytes: Buffer.byteLength(instructions, "utf8"),
  };
}

const tokens = (bytes) => Math.round(bytes / 4);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = args.urls.length > 0 ? args.urls : targetsFromConfig(args.dataDir);
  const rows = [];
  for (const target of targets) {
    try {
      const tools = await listTools(target);
      rows.push({
        server: target.name,
        sse: Boolean(target.sse),
        tools: tools.length,
        bytes: definitionBytes(tools),
        namesBytes: namesBytes(target.name, tools),
      });
    } catch (error) {
      rows.push({ server: target.name, sse: Boolean(target.sse), error: String(error.message ?? error) });
    }
  }
  const reachable = rows.filter((row) => row.error === undefined);
  const viaHub = reachable.filter((row) => !row.sse);
  const stillDirect = reachable.filter((row) => row.sse);
  const fullBytes = reachable.reduce((sum, row) => sum + row.bytes, 0);
  const deferredBytes = reachable.reduce((sum, row) => sum + row.namesBytes, 0);
  const hub = hubBytes();
  const hubSideBytes = hub.toolBytes + hub.instructionBytes + stillDirect.reduce((sum, row) => sum + row.bytes, 0);
  const summary = {
    servers: rows,
    full: { tools: reachable.reduce((sum, row) => sum + row.tools, 0), bytes: fullBytes, tokens: tokens(fullBytes) },
    claudeDeferred: { bytes: deferredBytes, tokens: tokens(deferredBytes) },
    hubOnly: { tools: hub.tools + stillDirect.reduce((sum, row) => sum + row.tools, 0), bytes: hubSideBytes, tokens: tokens(hubSideBytes) },
    coveredByHub: viaHub.map((row) => row.server),
  };
  summary.savedBytes = fullBytes - hubSideBytes;
  summary.savedPercent = fullBytes > 0 ? Math.round((summary.savedBytes / fullBytes) * 1000) / 10 : 0;

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log("server                 tools     bytes   ~tokens");
  for (const row of rows) {
    const label = `${row.server}${row.sse ? " (sse, 直连)" : ""}`.padEnd(22);
    if (row.error !== undefined) {
      console.log(`${label} 连不上：${row.error}`);
    } else {
      console.log(`${label} ${String(row.tools).padStart(5)} ${String(row.bytes).padStart(9)} ${String(tokens(row.bytes)).padStart(9)}`);
    }
  }
  console.log("");
  console.log(`全量注入：${summary.full.tools} 个工具，${summary.full.bytes} 字节，约 ${summary.full.tokens} tokens`);
  console.log(
    `只注入 hub：${summary.hubOnly.tools} 个工具，${summary.hubOnly.bytes} 字节（含 instructions ${hub.instructionBytes} 字节），约 ${summary.hubOnly.tokens} tokens`,
  );
  console.log(`Claude 原生延迟加载（只见工具名，估下限）：${deferredBytes} 字节，约 ${tokens(deferredBytes)} tokens`);
  console.log(`相对全量注入节省：${summary.savedBytes} 字节（${summary.savedPercent}%）；相对 Claude 延迟加载：${deferredBytes - hubSideBytes} 字节`);
  if (rows.some((row) => row.error !== undefined)) {
    console.log("注：连不上的服务器不计入两侧。");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
