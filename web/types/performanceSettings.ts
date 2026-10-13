/**
 * `[performance]` 性能设置（镜像 cc-panes-core `PerformanceSettings`，docs/107）。
 *
 * 从 `types/settings.ts` 拆出（该文件已接近行数棘轮上限），仍由 `types/settings.ts`
 * 与 `types/index.ts` 重导出。`null` 表示"按核数自动"，有效值由后端
 * `effective_*(cores)` 决定；前端只负责展示与编辑，不自行折算。
 * 钳位区间与后端 `merge_missing_defaults` 同口径，见 `PERFORMANCE_LIMITS`。
 */
export interface PerformanceSettings {
  /** 向新会话注入构建并行度环境（CARGO_BUILD_JOBS / MAKEFLAGS / … / RIPGREP_CONFIG_PATH）。只影响新会话 */
  buildParallelismEnabled: boolean;
  /** 构建并行度；null = max(2, cores - 8) */
  buildJobs: number | null;
  /** ripgrep 线程数；null = max(2, buildJobs / 2) */
  rgThreads: number | null;
  /** Codex 轻量模式：tui.animations=false、tui.auto_recap=false */
  codexLightweightEnabled: boolean;
  /** Codex 低配模式：agents.max_concurrent_threads_per_session=2 */
  codexLowSpecMode: boolean;
  /** 重负载门禁（cc-panes-ctl run --heavy）。默认关 = 直通 */
  heavyGateEnabled: boolean;
  /** 门禁槽位；null = max(1, cores / 8)，钳 1..=32 */
  heavyGateSlots: number | null;
  /** 门禁排队超时（秒），到点强制放行；钳 10..=3600 */
  heavyGateTimeoutSecs: number;
  /** 重负载命令台账（hook + 采样器落 SQLite） */
  heavyLedgerEnabled: boolean;
  /** WSL 会话进 systemd user scope 并带 cgroup 配额（探测到 systemd 才生效） */
  wslQuotaEnabled: boolean;
  /** WSL scope 的 CPUWeight（systemd 1..=10000，默认 20） */
  wslCpuWeight: number;
  /** WSL scope 的 MemoryHigh 占物理内存百分比（0 = 不设，默认；钳 0..=90） */
  wslMemoryHighPercent: number;
  /** Windows Job 内存通知阈值占物理内存百分比（0 = 关）。只告警不限制 */
  jobMemoryNotifyPercent: number;
  /** 隐藏窗格最多保留多少个未停泊的 xterm 实例；超出按 LRU 停泊。钳 2..=12 */
  parkedTerminalLimit: number;
  /** 窗格隐藏多久后停泊（秒）。钳 5..=600 */
  parkDelaySecs: number;
}

/** 与 Rust `performance_settings.rs` 常量同口径的钳位区间（UI 输入框 min/max 用）。 */
export const PERFORMANCE_LIMITS = {
  buildJobs: { min: 1, max: 512 },
  rgThreads: { min: 1, max: 512 },
  heavyGateSlots: { min: 1, max: 32 },
  heavyGateTimeoutSecs: { min: 10, max: 3600 },
  wslCpuWeight: { min: 1, max: 10_000 },
  wslMemoryHighPercent: { min: 0, max: 90 },
  jobMemoryNotifyPercent: { min: 0, max: 100 },
  parkedTerminalLimit: { min: 2, max: 12 },
  parkDelaySecs: { min: 5, max: 600 },
} as const;

/** 默认值与 Rust `PerformanceSettings::default()` 同口径；只兜 settings 尚未加载 / 老配置缺键的窄窗口。 */
export const DEFAULT_PERFORMANCE_SETTINGS: PerformanceSettings = {
  buildParallelismEnabled: true,
  buildJobs: null,
  rgThreads: null,
  codexLightweightEnabled: true,
  codexLowSpecMode: false,
  heavyGateEnabled: false,
  heavyGateSlots: null,
  heavyGateTimeoutSecs: 300,
  heavyLedgerEnabled: true,
  wslQuotaEnabled: true,
  wslCpuWeight: 20,
  wslMemoryHighPercent: 0,
  jobMemoryNotifyPercent: 25,
  parkedTerminalLimit: 6,
  parkDelaySecs: 30,
};
