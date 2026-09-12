// CC-Panes MCP bridge for pi (docs/104).
//
// pi upstream has no MCP client (0.85.x verified: zero MCP strings in its own
// code; the extension system is pi's blessed customization surface). CC-Panes
// drops this file into <agentDir>/extensions/ at launch and points
// CCPANES_MCP_CONFIG at a per-session JSON config ({"mcpServers": {...}},
// Claude shape). Every configured server is connected with a minimal,
// dependency-free MCP client and each of its tools is registered as a native
// pi tool named mcp__<server>__<tool>.
//
// Inert without the env var, so the file is safe to leave in a user's global
// ~/.pi/agent/extensions for regular pi usage outside CC-Panes.
//
// Hard rules:
// - NEVER write to stdout: in `pi --mode rpc` stdout is the JSONL protocol
//   channel. Diagnostics go to stderr (console.error) only.
// - Feature-detect the extension API: if a future pi renames registerTool the
//   bridge no-ops instead of crashing agent startup.
// - One failing server must never block the others or the agent itself.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const CLIENT_INFO = { name: "ccpanes-mcp-bridge", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const MAX_TOOL_NAME_LENGTH = 64;

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function createRpcState() {
	return { nextId: 1, pending: new Map() };
}

function settlePending(rpc, id, error, result) {
	const entry = rpc.pending.get(id);
	if (!entry) return;
	rpc.pending.delete(id);
	clearTimeout(entry.timer);
	if (error) entry.reject(error);
	else entry.resolve(result);
}

function trackRequest(rpc, id, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			rpc.pending.delete(id);
			reject(new Error(`MCP request ${id} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		rpc.pending.set(id, { resolve, reject, timer });
	});
}

function rejectAllPending(rpc, error) {
	for (const id of [...rpc.pending.keys()]) {
		settlePending(rpc, id, error);
	}
}

function handleMessage(rpc, message) {
	if (!message || typeof message !== "object") return;
	if (message.id === undefined || message.id === null) return; // notification
	const id = message.id;
	if (!rpc.pending.has(id) && !rpc.pending.has(String(id))) return;
	const key = rpc.pending.has(id) ? id : String(id);
	if (message.error) {
		settlePending(rpc, key, new Error(mcpErrorText(message.error)));
	} else {
		settlePending(rpc, key, undefined, message.result);
	}
}

function mcpErrorText(error) {
	const parts = [`code ${error?.code ?? "?"}`];
	if (error?.message) parts.push(String(error.message));
	if (error?.data !== undefined) {
		try {
			parts.push(JSON.stringify(error.data));
		} catch {
			// non-serializable diagnostic data is not worth crashing over
		}
	}
	return `MCP error (${parts.join(", ")})`;
}

// ---------------------------------------------------------------------------
// stdio transport (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------

function quoteWindowsShellArg(arg) {
	// With shell:true Node concatenates args verbatim; quote anything the
	// cmd.exe tokenizer would split or interpret.
	if (arg === "") return '""';
	if (!/[\s"&|<>^%!]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '\\"')}"`;
}

class StdioMcpClient {
	constructor(serverName, entry) {
		this.serverName = serverName;
		this.entry = entry;
		this.rpc = createRpcState();
		this.child = null;
		this.buffer = "";
		this.closed = false;
	}

	async connect() {
		const command = this.entry.command;
		const args = Array.isArray(this.entry.args) ? this.entry.args.map(String) : [];
		const isWindows = process.platform === "win32";
		// On Windows, spawn through cmd.exe so npm-style shims (npx.cmd, …)
		// resolve; args are pre-quoted to survive the shell tokenizer.
		const spawnCommand = isWindows ? quoteWindowsShellArg(command) : command;
		const spawnArgs = isWindows ? args.map(quoteWindowsShellArg) : args;
		this.child = spawn(spawnCommand, spawnArgs, {
			shell: isWindows,
			env: { ...process.env, ...(this.entry.env ?? {}) },
			cwd: this.entry.cwd || process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child.stdin.on("error", () => {
			// EPIPE when the server dies mid-write; the exit handler reports it
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
		this.child.stderr.on("data", (chunk) => {
			const text = String(chunk).trim();
			if (text) console.error(`[ccpanes-mcp ${this.serverName}] ${text}`);
		});
		this.child.on("error", (error) => {
			console.error(`[ccpanes-mcp ${this.serverName}] spawn failed: ${error?.message ?? error}`);
			this.#fail(new Error(`stdio server exited early: ${error?.message ?? error}`));
		});
		this.child.on("exit", (code) => {
			if (!this.closed) this.#fail(new Error(`stdio server exited (code ${code})`));
		});

		try {
			await this.#handshake();
		} catch (error) {
			this.close();
			throw error;
		}
	}

	#onStdout(chunk) {
		this.buffer += chunk;
		let newline;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			try {
				handleMessage(this.rpc, JSON.parse(line));
			} catch {
				// non-JSON noise on stdout: ignore rather than kill the session
			}
		}
	}

	#fail(error) {
		rejectAllPending(this.rpc, error);
	}

	async request(method, params, timeoutMs) {
		if (!this.child || this.child.exitCode !== null) {
			throw new Error(`stdio server for "${this.serverName}" is not running`);
		}
		const id = this.rpc.nextId++;
		const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		const promise = trackRequest(this.rpc, id, timeoutMs);
		this.child.stdin.write(payload);
		return promise;
	}

	notify(method, params) {
		if (!this.child || this.child.exitCode !== null) return;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	async #handshake() {
		await this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		}, CONNECT_TIMEOUT_MS);
		this.notify("notifications/initialized", {});
	}

	async listTools() {
		const result = await this.request("tools/list", {}, CONNECT_TIMEOUT_MS);
		return Array.isArray(result?.tools) ? result.tools : [];
	}

	async callTool(name, args, timeoutMs) {
		return this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
	}

	close() {
		this.closed = true;
		if (this.child && this.child.exitCode === null) {
			try {
				this.child.kill();
			} catch {
				// best-effort teardown
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport
// ---------------------------------------------------------------------------

class HttpMcpClient {
	constructor(serverName, entry) {
		this.serverName = serverName;
		this.url = entry.url;
		this.headers = entry.headers ?? {};
		this.sessionId = null;
		this.rpc = createRpcState();
	}

	async connect() {
		await this.#send({
			jsonrpc: "2.0",
			id: this.rpc.nextId++,
			method: "initialize",
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: CLIENT_INFO,
			},
		}, CONNECT_TIMEOUT_MS, true);
		await this.#send({
			jsonrpc: "2.0",
			method: "notifications/initialized",
			params: {},
		}, CONNECT_TIMEOUT_MS, false);
	}

	async #send(body, timeoutMs, expectResponse) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const headers = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.headers,
		};
		if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
		let response;
		try {
			response = await fetch(this.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
		const session = response.headers.get("mcp-session-id");
		if (session) this.sessionId = session;
		if (!expectResponse) {
			// notifications answer 202/200 with an empty body; drain and move on
			await response.arrayBuffer().catch(() => {});
			if (!response.ok && response.status !== 202) {
				throw new Error(`HTTP ${response.status} from "${this.serverName}"`);
			}
			return undefined;
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`HTTP ${response.status} from "${this.serverName}": ${text.slice(0, 300)}`);
		}
		const contentType = response.headers.get("content-type") ?? "";
		const text = await response.text();
		if (contentType.includes("text/event-stream")) {
			return pickRpcResponseFromSse(text, body.id);
		}
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) {
			const match = parsed.find((m) => m && m.id === body.id);
			if (match?.error) throw new Error(mcpErrorText(match.error));
			return match?.result;
		}
		if (parsed?.error) throw new Error(mcpErrorText(parsed.error));
		return parsed?.result;
	}

	async request(method, params, timeoutMs) {
		const id = this.rpc.nextId++;
		return this.#send({ jsonrpc: "2.0", id, method, params }, timeoutMs, true);
	}

	async listTools() {
		const result = await this.request("tools/list", {}, CONNECT_TIMEOUT_MS);
		return Array.isArray(result?.tools) ? result.tools : [];
	}

	async callTool(name, args, timeoutMs) {
		return this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
	}

	close() {
		// stateless: nothing to tear down (session id dies with the process)
	}
}

function pickRpcResponseFromSse(text, id) {
	for (const block of text.split(/\r?\n\r?\n/)) {
		const dataLines = [];
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
		}
		if (dataLines.length === 0) continue;
		let message;
		try {
			message = JSON.parse(dataLines.join("\n"));
		} catch {
			continue;
		}
		if (message && message.id === id) {
			if (message.error) throw new Error(mcpErrorText(message.error));
			return message.result;
		}
	}
	throw new Error(`no JSON-RPC response for id ${id} in SSE stream`);
}

// ---------------------------------------------------------------------------
// pi tool registration
// ---------------------------------------------------------------------------

function sanitizeToolName(serverName, toolName) {
	const raw = `mcp__${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (raw.length <= MAX_TOOL_NAME_LENGTH) return raw;
	// Provider tool-name limits are hard (64 chars); keep a stable hash suffix
	// so the same tool always maps to the same truncated name.
	let hash = 0;
	for (const ch of raw) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
	const keep = MAX_TOOL_NAME_LENGTH - 9;
	return `${raw.slice(0, keep)}_${hash.toString(16).padStart(8, "0")}`;
}

function normalizeInputSchema(schema) {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return { type: "object", properties: {} };
	}
	if (schema.type !== "object") {
		// pi/TypeBox expects an object schema at the root; wrap anything else
		return { type: "object", properties: { value: schema } };
	}
	return schema;
}

function toAgentToolResult(serverName, toolName, result) {
	const content = [];
	for (const item of result?.content ?? []) {
		if (item?.type === "text") {
			content.push({ type: "text", text: String(item.text ?? "") });
		} else if (item?.type === "image" && typeof item.data === "string") {
			content.push({
				type: "image",
				data: item.data,
				mimeType: String(item.mimeType ?? "image/png"),
			});
		} else if (item && typeof item === "object") {
			let serialized;
			try {
				serialized = JSON.stringify(item);
			} catch {
				serialized = String(item);
			}
			content.push({ type: "text", text: serialized });
		}
	}
	if (content.length === 0) {
		const structured = result?.structuredContent;
		content.push({
			type: "text",
			text: structured === undefined ? "(empty result)" : JSON.stringify(structured),
		});
	}
	if (result?.isError) {
		content.unshift({
			type: "text",
			text: `MCP tool "${serverName}/${toolName}" reported an error:`,
		});
	}
	return { content, details: { server: serverName, tool: toolName, isError: !!result?.isError } };
}

function errorResult(serverName, toolName, error) {
	return {
		content: [
			{
				type: "text",
				text: `MCP call "${serverName}/${toolName}" failed: ${error?.message ?? error}`,
			},
		],
		details: { server: serverName, tool: toolName, isError: true },
	};
}

function callTimeoutMs(entry) {
	return typeof entry.timeout === "number" && entry.timeout > 0
		? entry.timeout
		: DEFAULT_CALL_TIMEOUT_MS;
}

async function bridgeServer(pi, serverName, entry) {
	if (!entry || typeof entry !== "object") return;
	if (entry.enabled === false) return;
	const transport = entry.type ?? (entry.command ? "stdio" : entry.url ? "http" : null);
	let client;
	if (transport === "stdio" && entry.command) {
		client = new StdioMcpClient(serverName, entry);
	} else if ((transport === "http" || transport === "streamable-http") && entry.url) {
		client = new HttpMcpClient(serverName, entry);
	} else {
		console.error(
			`[ccpanes-mcp] skipping "${serverName}": unsupported transport "${transport ?? "unknown"}" ` +
			`(the bridge speaks stdio and Streamable HTTP; legacy SSE is not implemented)`,
		);
		return;
	}

	await client.connect();
	const tools = await client.listTools();
	const timeout = callTimeoutMs(entry);
	let registered = 0;
	for (const tool of tools) {
		if (!tool?.name) continue;
		const toolName = tool.name;
		pi.registerTool({
			name: sanitizeToolName(serverName, toolName),
			label: `${serverName}: ${toolName}`,
			description: `[MCP ${serverName}] ${tool.description ?? toolName}`.trim(),
			parameters: normalizeInputSchema(tool.inputSchema),
			async execute(_toolCallId, params, signal) {
				if (signal?.aborted) return errorResult(serverName, toolName, new Error("aborted"));
				try {
					const result = await client.callTool(toolName, params ?? {}, timeout);
					return toAgentToolResult(serverName, toolName, result);
				} catch (error) {
					return errorResult(serverName, toolName, error);
				}
			},
		});
		registered += 1;
	}
	bridgedClients.push(client);
	console.error(`[ccpanes-mcp] ${serverName}: ${registered} tool(s) bridged`);
}

// Kept module-global so process exit can tear spawned servers down. Signal
// handlers are deliberately NOT installed: registering one would replace
// Node's default termination and could swallow pi's own SIGINT handling.
// Servers killed by a crashing parent rely on the MCP stdio contract (exit on
// stdin EOF) plus this hook for normal shutdowns.
const bridgedClients = [];
let exitHookInstalled = false;

function installExitHook() {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const client of bridgedClients) {
			try {
				client.close();
			} catch {
				// teardown is best-effort
			}
		}
	});
}

export default async function ccpanesMcpBridge(pi) {
	// Version-drift guard: unknown/renamed extension API → stay inert.
	if (!pi || typeof pi.registerTool !== "function") return;
	const configPath = process.env.CCPANES_MCP_CONFIG;
	if (!configPath) return;

	let servers;
	try {
		const raw = await readFile(configPath, "utf8");
		const parsed = JSON.parse(raw);
		servers = parsed?.mcpServers;
	} catch (error) {
		console.error(
			`[ccpanes-mcp] cannot read ${configPath}: ${error?.message ?? error}; no MCP tools bridged`,
		);
		return;
	}
	if (!servers || typeof servers !== "object") return;

	const names = Object.keys(servers).filter((name) => name.length > 0);
	if (names.length === 0) return;

	installExitHook();
	// Connect every server concurrently; one hanging/failing server must not
	// block the others (each carries its own CONNECT_TIMEOUT_MS).
	const results = await Promise.allSettled(
		names.map((name) =>
			bridgeServer(pi, name, servers[name]).catch((error) => {
				console.error(
					`[ccpanes-mcp] server "${name}" failed to bridge: ${error?.message ?? error}`,
				);
			}),
		),
	);
	const failed = results.filter((r) => r.status === "rejected").length;
	if (failed > 0) {
		console.error(`[ccpanes-mcp] ${failed} of ${names.length} server(s) failed to bridge`);
	}
}
