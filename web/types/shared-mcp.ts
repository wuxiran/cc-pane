/** Agent 自己配置文件里的 MCP（只读），环境变量只有键名 */
export interface AgentMcpServer {
  name: string;
  /** 配了它的 Agent，如 `claude`、`codex` */
  agents: string[];
  transport: string;
  command?: string | null;
  args: string[];
  url?: string | null;
  envKeys: string[];
}

/** 远程 MCP：不起本地进程、不占端口 */
export interface SharedMcpRemote {
  url: string;
  transport: "http" | "sse";
  headers: Record<string, string>;
}

/** 添加前要用户填的值 */
export interface McpMarketInput {
  key: string;
  where: "env" | "header" | "arg";
  label: string;
  description?: string;
  placeholder?: string;
  secret: boolean;
  required: boolean;
  /** 请求头的值模板，如 `Bearer {}` */
  format?: string;
}

/** 发现市场里的一条 MCP */
export interface McpMarketServer {
  id: string;
  name: string;
  title: string;
  description: string;
  descriptionZh?: string;
  publisher: string;
  icon: string;
  homepage: string;
  transport: string;
  runs: string;
  signIn: boolean;
  featured: boolean;
  inputs: McpMarketInput[];
  command: string;
  args: string[];
  url: string;
  headers: Record<string, string>;
}

export interface McpMarketResult {
  servers: McpMarketServer[];
  /** 联网搜索失败，当前只有本地结果 */
  partial: boolean;
  error?: string | null;
}

/** 桥接模式 */
export type BridgeMode = "mcp-proxy" | "native-http";

/** 单个共享 MCP Server 配置 */
export interface SharedMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  shared: boolean;
  port: number;
  bridgeMode: BridgeMode;
  remote?: SharedMcpRemote | null;
}

/** 运行时状态。线格式由 Rust `SharedMcpServerStatus` 的 `rename_all = "camelCase"` 决定 */
export type SharedMcpServerStatus =
  | "stopped"
  | "starting"
  | "running"
  | { failed: { message: string } };

export function isSharedMcpFailed(status: SharedMcpServerStatus): status is { failed: { message: string } } {
  return typeof status === "object" && status !== null && "failed" in status;
}

export function sharedMcpFailureMessage(status: SharedMcpServerStatus): string | null {
  return isSharedMcpFailed(status) ? status.failed.message : null;
}

/** 运行时信息（含配置 + 状态） */
export interface SharedMcpServerInfo {
  name: string;
  config: SharedMcpServerConfig;
  status: SharedMcpServerStatus;
  pid: number | null;
  url: string | null;
  restartCount: number;
}

/** 全局共享 MCP 配置 */
export interface SharedMcpConfig {
  servers: Record<string, SharedMcpServerConfig>;
  portRangeStart: number;
  portRangeEnd: number;
  healthCheckIntervalSecs: number;
  maxRestarts: number;
}
