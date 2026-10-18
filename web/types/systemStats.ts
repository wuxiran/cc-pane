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
  /** 读数来源：缺省 = Windows 进程树聚合；`"cgroup"` = WSL 侧 systemd scope（W6）。 */
  source?: string | null;
}

export interface OrphanProcessInfo {
  pid: number;
  name: string;
  command: string;
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
}

/** 会话之外的高负载进程（只读展示，**不提供任何操作**）。 */
export interface TopProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
}

export interface ResourceTree {
  system: SystemStats;
  appMemoryBytes: number;
  appMemoryPercent: number;
  sessions: SessionResourceUsage[];
  orphans: OrphanProcessInfo[];
  /**
   * 整机 CPU ≥ 60%（滞回 <45% 关）时才计算的"会话之外"前 3 名；平时与非 Windows 为
   * null/undefined（旧后端不返回该字段，消费方必须容忍缺失）。
   */
  topProcesses?: TopProcessInfo[] | null;
  sampledAt: number;
  elapsedMicros: number;
}

/** 会话级资源策略（后端 `SessionResourcePolicy`）。 */
export interface SessionResourcePolicy {
  lowerPriority: boolean;
  /** 1..=9，中性 5；null = 不设。 */
  cpuWeight: number | null;
  /** Windows EcoQoS（效率模式）：逐进程下发，后生子进程不覆盖。 */
  ecoQos: boolean;
}

export type ResourcePolicyOutcome = "applied" | "degraded" | "unsupported";

/** 策略下发结果（随 `TerminalStatusInfo.resourcePolicy` 上报，popover 显示"已降级：原因"）。 */
export interface ResourcePolicyStatus {
  outcome: ResourcePolicyOutcome;
  /** Degraded 的原因；WSL 配额 Applied 时是实际配额（`CPUWeight=20, MemoryHigh=25%`）。 */
  reason?: string | null;
  lowerPriority: boolean;
  ecoQos: boolean;
  cpuWeight?: number | null;
  /** W6：Linux 侧 `ccpanes-*` scope 确实存在（WSL 配额 Applied）。后端 false 时不发该字段。 */
  wslScope?: boolean;
}

/** Job 内存通知水位越线（W5，随 `TerminalStatusInfo.jobMemoryWarning` 上报；只是观测，build 不会失败）。 */
export interface JobMemoryWarning {
  /** 越线时内核报告的 Job 已提交内存（字节）。 */
  bytes: number;
  /** 当时的通知水位（字节）。 */
  limitBytes: number;
  /** 毫秒 epoch。 */
  at: number;
}

export interface KillProcessResult {
  pid: number;
  success: boolean;
  error: string | null;
}
