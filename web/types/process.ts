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
