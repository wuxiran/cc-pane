//! 重负载命令台账（docs/107 P2b）的数据模型。
//!
//! 隐私红线（同 `system_stats_service/diagnostics.rs`）：**绝不落原始命令行**。
//! 台账里只有 `cmd_normalized`（首段前两个 token）与 `cmd_redacted`（脱敏后、
//! 截断的命令），两者都由 `services::heavy_command_normalize` 产出。

use serde::{Deserialize, Serialize};

/// 一行台账的来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HeavyCommandSource {
    /// 只由 PreToolUse/PostToolUse hook 配对得到（有精确时长 / 退出码，没有资源峰值）。
    Hook,
    /// 只由边沿触发采样器观察到（有资源峰值，命令来自最重子进程的命令行）。
    Sampler,
    /// hook 行与采样 episode 时间重叠，已合并。
    Both,
}

impl HeavyCommandSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hook => "hook",
            Self::Sampler => "sampler",
            Self::Both => "both",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "sampler" => Self::Sampler,
            "both" => Self::Both,
            _ => Self::Hook,
        }
    }
}

/// 写入一条 hook 起始行所需的会话上下文（来自 `terminal_sessions` 表）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HeavySessionContext {
    pub project_path: String,
    pub workspace: Option<String>,
    pub cli_tool: String,
    pub runtime_kind: String,
}

/// 新建一行（hook ToolBefore 或 sampler episode 封账）。
#[derive(Debug, Clone, PartialEq)]
pub struct NewHeavyCommand {
    pub session_id: String,
    pub context: HeavySessionContext,
    pub cmd_normalized: String,
    pub cmd_redacted: String,
    pub source: HeavyCommandSource,
    /// 毫秒 epoch。
    pub started_at: i64,
}

/// 采样器封账的一段 episode。
#[derive(Debug, Clone, PartialEq)]
pub struct HeavyEpisode {
    pub session_id: String,
    pub context: HeavySessionContext,
    /// 最重子进程命令（已归一化）；拿不到时为空串，合并进 hook 行时不覆盖。
    pub cmd_normalized: String,
    pub cmd_redacted: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub peak_cpu_pct: f32,
    pub peak_mem_bytes: u64,
    pub cpu_seconds: f64,
}

/// 台账一行（回传前端）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeavyCommandRecord {
    pub id: i64,
    pub session_id: String,
    pub project_path: String,
    pub workspace: Option<String>,
    pub cli_tool: String,
    pub runtime_kind: String,
    pub cmd_normalized: String,
    pub cmd_redacted: String,
    pub source: HeavyCommandSource,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub exit_code: Option<i32>,
    pub peak_cpu_pct: Option<f32>,
    pub peak_mem_bytes: Option<u64>,
    pub cpu_seconds: Option<f64>,
    pub target: String,
    pub offloaded_reason: Option<String>,
    pub created_at: i64,
}

/// 列表查询参数。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeavyCommandQuery {
    /// 只看这个项目；`None` = 全部。
    #[serde(default)]
    pub project_path: Option<String>,
    /// 只看 `started_at >= since`（毫秒 epoch）。
    #[serde(default)]
    pub since: Option<i64>,
    /// 行数上限；0 / 缺省 = 200。
    #[serde(default)]
    pub limit: Option<u32>,
}

/// 按归一化命令聚合（"最贵命令"表）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeavyCommandAggregate {
    pub cmd_normalized: String,
    pub runs: u32,
    pub total_cpu_seconds: f64,
    /// 只统计已封账（`duration_ms` 非空）的行。
    pub p50_duration_ms: Option<i64>,
    pub p95_duration_ms: Option<i64>,
    pub peak_mem_bytes: Option<u64>,
    pub last_started_at: i64,
}

/// 采样器计数器（docs/41：监控自身不得吃资源，空闲必须零建树）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeavySamplerStats {
    /// 只查了整机 CPU 就返回的 tick 数。
    pub idle_ticks: u64,
    /// 真正枚举过进程树的次数。
    pub tree_samples: u64,
    /// 当前开着的 episode 数。
    pub open_episodes: u32,
    /// 已封账的 episode 总数。
    pub closed_episodes: u64,
    /// 当前是否武装（整机 CPU 高于阈值）。
    pub armed: bool,
    /// 采样器线程是否在跑（台账开关关掉时线程仍在、但不建树）。
    pub running: bool,
}
