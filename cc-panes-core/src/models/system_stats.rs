use serde::Serialize;

/// 整机 CPU 与内存统计。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_percent: f32,
    pub mem_used: u64,
    pub mem_total: u64,
}

/// 活跃终端账本中的 session -> PTY 根进程映射。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedSessionRoot {
    pub session_id: String,
    pub root_pid: u32,
}

/// 会话进程树里的单个进程，用于在资源管理器里展开查看「底下挂了什么」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProcessInfo {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub command: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

/// 明细上限之外那部分的聚合。
///
/// 存在的意义是**不静默截断**：`cargo build` 能挂出上百个 rustc，明细不可能全回传，
/// 但"回传了前 N 条"与"一共就这 N 条"在 UI 上完全同形——不回传这个摘要，用户会以为
/// 看到的就是全部。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncatedProcessSummary {
    pub process_count: u32,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

/// 单个受管会话的整棵 PTY 进程树资源聚合。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResourceUsage {
    pub session_id: String,
    pub root_pid: u32,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub process_count: u32,
    /// 进程树明细，按内存降序，最多 `SESSION_PROCESS_DETAIL_LIMIT` 条。
    pub processes: Vec<SessionProcessInfo>,
    /// 超出上限被折叠的部分；`None` 表示 `processes` 就是全部。
    pub truncated: Option<TruncatedProcessSummary>,
}

/// 可安全清理的孤立终端进程树根节点。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanProcessInfo {
    pub pid: u32,
    pub name: String,
    pub command: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub process_count: u32,
}

/// 一次按需进程枚举的完整结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTree {
    pub system: SystemStats,
    pub app_memory_bytes: u64,
    pub app_memory_percent: f32,
    pub sessions: Vec<SessionResourceUsage>,
    pub orphans: Vec<OrphanProcessInfo>,
    pub sampled_at: u64,
    pub elapsed_micros: u64,
}

/// 单个孤立进程树的终止结果；批量操作允许部分成功。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillProcessResult {
    pub pid: u32,
    pub success: bool,
    pub error: Option<String>,
}
