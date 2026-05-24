use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 运行实例状态
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunnerInstanceStatus {
    Running,
    Exited,
    Orphaned,
}

impl RunnerInstanceStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Orphaned => "orphaned",
        }
    }
}

impl std::str::FromStr for RunnerInstanceStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "running" => Ok(Self::Running),
            "exited" => Ok(Self::Exited),
            "orphaned" => Ok(Self::Orphaned),
            _ => Err(format!("Invalid RunnerInstanceStatus: {}", s)),
        }
    }
}

impl std::fmt::Display for RunnerInstanceStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 启动配置（持久化的运行方式记忆）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerProfile {
    pub id: String,
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    pub name: String,
    pub command: String,
    pub cwd: String,
    /// local / wsl / ssh
    pub runtime_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wsl_distro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_machine_id: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub expected_ports: Vec<u16>,
    /// 元信息提示：npm / cargo / mvn / sh / docker
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_started_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建/更新启动配置的草稿
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerProfileDraft {
    /// 提供 id 则更新；不提供则创建
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub project_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    pub name: String,
    pub command: String,
    pub cwd: String,
    pub runtime_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl_distro: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_machine_id: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub expected_ports: Vec<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_hint: Option<String>,
}

/// 运行实例（某一次启动的运行时快照）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerInstance {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub root_pid: u32,
    pub runtime_kind: String,
    pub command: String,
    pub cwd: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub status: RunnerInstanceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// 端口占用快照
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortClaim {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub pid: u32,
    pub port: u16,
    /// tcp / tcp6 / udp / udp6
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen_addr: Option<String>,
    pub detected_at: String,
}

/// 端口冲突（启动预演返回）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortConflict {
    pub port: u16,
    pub protocol: String,
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen_addr: Option<String>,
    /// 该 PID 所属的已登记 instance（若有）— 帮助 skill 判断是否同一 profile 残留
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owning_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owning_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owning_profile_name: Option<String>,
}

/// 启动预演（启动前调用 plan_runner_launch 得到）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerLaunchPlan {
    pub profile_id: String,
    pub profile_name: String,
    /// 预期监听端口的当前占用情况；空 = 无冲突
    pub conflicts: Vec<PortConflict>,
    /// skill 友好的处理建议
    pub suggested_actions: Vec<RunnerLaunchSuggestedAction>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunnerLaunchSuggestedAction {
    /// 无冲突，直接启动
    StartDirect,
    /// 冲突 PID 是同一 profile 上次的残留，可安全 kill 后启动
    KillSelfThenStart,
    /// 冲突 PID 是其他 profile 的进程，需确认
    AskUserBeforeKill,
    /// 冲突 PID 不在 ccpane 登记里（陌生进程），建议换端口或人工处理
    InvestigateUnknown,
}

/// 跨 workspace 端口预留(供 list_workspace_port_reservations MCP 使用)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortReservation {
    pub profile_id: String,
    pub profile_name: String,
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    pub expected_ports: Vec<u16>,
}

/// start_runner 返回状态枚举
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunnerStartStatus {
    /// 同 profile 已有 running instance(且 PID 还活),复用上一个
    Reused,
    /// 端口冲突阻止启动,需要 AI/用户决策
    Blocked,
    /// 真正启动了新 instance
    Launched,
}

/// start_runner 返回结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerStartResult {
    pub status: RunnerStartStatus,
    /// Reused / Launched 时非空;Blocked 时为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    /// Reused / Launched 时非空;Blocked 时为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Blocked 时携带完整 LaunchPlan(含 conflicts + suggestedActions);
    /// Reused / Launched 时为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_plan: Option<RunnerLaunchPlan>,
}
