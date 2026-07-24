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

/// 单个受管会话的整棵 PTY 进程树资源聚合。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResourceUsage {
    pub session_id: String,
    pub root_pid: u32,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub process_count: u32,
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
