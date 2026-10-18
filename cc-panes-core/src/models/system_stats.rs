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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManagedSessionRoot {
    pub session_id: String,
    pub root_pid: u32,
    /// `local` / `wsl` / `ssh`。W6：WSL 根的真读数在 Linux 侧 cgroup，不在 wsl.exe 进程树。
    pub runtime_kind: Option<String>,
    /// WSL 发行版；按它批量读 cgroup。
    pub wsl_distro: Option<String>,
    /// W6：Linux 侧 `ccpanes-*.scope` 确实存在（`ResourcePolicyStatus.wsl_scope`）。
    /// 只有它为 true 才值得起 `wsl.exe` 读 cgroup；配额关 / 降级 `nice` 的 WSL 会话
    /// 没有 scope，读了也是空，不该为此唤醒 VM。
    pub wsl_scope: bool,
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
    /// 读数来源。`None` = Windows 进程树聚合；`"cgroup"` = WSL 侧 systemd scope 的
    /// `memory.current` / `cpu.stat`（W6）。UI 据此标注"cgroup"。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
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

/// 会话之外的高负载进程（资源管理器"会话之外"块）。
///
/// **只读展示**：不回传命令行（可能含凭据），也不提供任何操作——对会话外进程
/// 杀错 / 降错的代价远高于看一眼。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
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
    /// 会话之外的前 3 名。只在整机 CPU ≥ 60%（滞回 <45% 关）时计算（docs/41：监控
    /// 不得常驻吃资源）；平时与非 Windows 为 `None`，字段不序列化，旧前端无感。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_processes: Option<Vec<TopProcessInfo>>,
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
