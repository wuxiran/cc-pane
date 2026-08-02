export interface SystemStats {
  cpuPercent: number;
  memUsed: number;
  memTotal: number;
}

/** 会话进程树里的单个进程（资源管理器展开明细用）。 */
export interface SessionProcessInfo {
  pid: number;
  parentPid: number | null;
  name: string;
  command: string;
  cpuPercent: number;
  memoryBytes: number;
}

/** 明细上限之外被折叠的部分。不展示它，"前 N 条"和"一共 N 条"在 UI 上完全同形。 */
export interface TruncatedProcessSummary {
  processCount: number;
  cpuPercent: number;
  memoryBytes: number;
}

export interface SessionResourceUsage {
  sessionId: string;
  rootPid: number;
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
  /** 进程树明细，按内存降序。旧后端可能不返回，消费方必须容忍缺失。 */
  processes?: SessionProcessInfo[];
  truncated?: TruncatedProcessSummary | null;
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
