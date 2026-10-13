/**
 * 重负载命令台账（docs/107 P2b）。后端 `models/heavy_command.rs` 的 camelCase 镜像。
 *
 * 隐私：后端只落 `cmdNormalized` / `cmdRedacted`，前端拿不到原始命令行。
 */

export type HeavyCommandSource = "hook" | "sampler" | "both";

export interface HeavyCommandRecord {
  id: number;
  sessionId: string;
  projectPath: string;
  workspace: string | null;
  cliTool: string;
  runtimeKind: string;
  cmdNormalized: string;
  cmdRedacted: string;
  source: HeavyCommandSource;
  /** 毫秒 epoch */
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  peakCpuPct: number | null;
  peakMemBytes: number | null;
  cpuSeconds: number | null;
  target: string;
  offloadedReason: string | null;
  createdAt: number;
}

export interface HeavyCommandQuery {
  projectPath?: string | null;
  /** 毫秒 epoch，只看 startedAt >= since */
  since?: number | null;
  limit?: number | null;
}

export interface HeavyCommandAggregate {
  cmdNormalized: string;
  runs: number;
  totalCpuSeconds: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  peakMemBytes: number | null;
  lastStartedAt: number;
}

/** 采样器计数器：空闲时 `treeSamples` 必须不涨（docs/41）。 */
export interface HeavySamplerStats {
  idleTicks: number;
  treeSamples: number;
  openEpisodes: number;
  closedEpisodes: number;
  armed: boolean;
  running: boolean;
}

/** Tauri 事件 `heavy-session-usage` 的载荷；`active:false` = episode 封账。 */
export interface HeavySessionUsagePayload {
  sessionId: string;
  cpuPercent: number;
  memoryBytes: number;
  active: boolean;
}
