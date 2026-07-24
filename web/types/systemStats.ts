export interface SystemStats {
  cpuPercent: number;
  memUsed: number;
  memTotal: number;
}

export interface SessionResourceUsage {
  sessionId: string;
  rootPid: number;
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
}

export interface OrphanProcessInfo {
  pid: number;
  name: string;
  command: string;
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
}

export interface ResourceTree {
  system: SystemStats;
  appMemoryBytes: number;
  appMemoryPercent: number;
  sessions: SessionResourceUsage[];
  orphans: OrphanProcessInfo[];
  sampledAt: number;
  elapsedMicros: number;
}

export interface KillProcessResult {
  pid: number;
  success: boolean;
  error: string | null;
}
