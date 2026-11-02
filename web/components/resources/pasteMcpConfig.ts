// 粘贴 MCP 配置的纯解析层：接受 README 里常见的几种 JSON 形状，产出待确认条目。
// 只负责识别，不做任何写入；同名判断和目标层选择留给确认界面。

export interface PastedMcpServer {
  name: string;
  /** stdio 条目的启动命令；远程条目为空 */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 远程条目的地址。现有 MCP 写入接口只存命令式条目，界面据此标为不可添加 */
  url?: string;
  headers?: Record<string, string>;
}

export type PasteMcpResult =
  | { ok: true; servers: PastedMcpServer[] }
  | { ok: false; error: "empty" | "invalidJson" | "noServers" };

const SERVER_MAP_KEYS = ["mcpServers", "servers", "mcp", "context_servers"] as const;
const URL_KEYS = ["url", "serverUrl", "httpUrl", "uri"] as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean"
        ? [[key, String(item)]]
        : [],
    ),
  );
}

/** README 片段常带尾逗号，或者只贴了 `"name": { … }` 这一段没有外层大括号。 */
function parseLenient(text: string): unknown {
  const withoutTrailingCommas = text.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch {
    try {
      return JSON.parse(`{${withoutTrailingCommas.replace(/,\s*$/, "")}}`);
    } catch {
      return undefined;
    }
  }
}

function toServer(name: string, entry: unknown): PastedMcpServer | null {
  if (!isObject(entry)) return null;
  const url = URL_KEYS.map((key) => entry[key]).find((value) => typeof value === "string" && value.trim());
  if (typeof url === "string") {
    return { name, command: "", args: [], env: {}, url: url.trim(), headers: stringRecord(entry.headers ?? entry.http_headers) };
  }
  if (typeof entry.command !== "string" || !entry.command.trim()) return null;
  const args = Array.isArray(entry.args)
    ? entry.args.filter((arg): arg is string | number => typeof arg === "string" || typeof arg === "number").map(String)
    : [];
  return { name, command: entry.command.trim(), args, env: stringRecord(entry.env) };
}

/** 名称会进配置文件和工具前缀，收敛成各 CLI 都接受的字符集。 */
export function normalizeMcpName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function parseMcpPaste(text: string): PasteMcpResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "empty" };
  const value = parseLenient(trimmed);
  if (!isObject(value)) return { ok: false, error: "invalidJson" };

  const mapKey = SERVER_MAP_KEYS.find((key) => isObject(value[key]));
  const map = mapKey ? (value[mapKey] as JsonObject) : value;
  // 顶层就是单个条目（没有名字）：name 留空，让用户在确认界面填
  const bare = toServer("", value);
  const candidates = !mapKey && bare ? [bare] : Object.entries(map).map(([name, entry]) => toServer(normalizeMcpName(name), entry));
  const servers = candidates.filter((server): server is PastedMcpServer => server !== null);
  return servers.length > 0 ? { ok: true, servers } : { ok: false, error: "noServers" };
}

const SENSITIVE_NAME = /(token|secret|key|password|passwd|pwd|auth|credential|bearer|cookie)/i;

/** 确认列表上的展示值：名字像凭据的整段遮罩，其余原样。只用于显示，写入仍用原值。 */
export function maskSensitiveValue(name: string, value: string): string {
  return SENSITIVE_NAME.test(name) ? "••••••" : value;
}
