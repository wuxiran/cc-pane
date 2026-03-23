export type ClaudeProcessType = "claude_cli" | "claude_node" | "mcp_server" | "other";

export interface ClaudeProcess {
  pid: number;
  parentPid: number | null;
  name: string;
  command: string;
  cwd: string | null;
  memoryBytes: number;
  startTime: number;
  processType: ClaudeProcessType;
}

export interface ProcessScanResult {
  processes: ClaudeProcess[];
  totalCount: number;
  totalMemoryBytes: number;
  scannedAt: string;
}

/** 轻量级资源统计（StatusBar 用） */
export interface ResourceStats {
  totalCpuPercent: number;
  totalMemoryBytes: number;
  processCount: number;
  timestamp: number;
}
