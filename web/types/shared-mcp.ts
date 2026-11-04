/** `~/.claude.json` 里的用户级 MCP（只读）：并入 Claude 会话且不受启动档控制 */
export interface ClaudeUserMcpServer {
  name: string;
  transport: string;
  command?: string | null;
  args: string[];
  url?: string | null;
  envKeys: string[];
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
