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

/** 运行时状态 */
export type SharedMcpServerStatus =
  | "Stopped"
  | "Starting"
  | "Running"
  | { Failed: { message: string } };

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
