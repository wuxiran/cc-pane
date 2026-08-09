use serde::{Deserialize, Serialize};

/// 编排任务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskBindingStatus {
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
}

impl TaskBindingStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

impl std::str::FromStr for TaskBindingStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "waiting" => Ok(Self::Waiting),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            _ => Err(format!("Invalid TaskBindingStatus: {}", s)),
        }
    }
}

impl std::fmt::Display for TaskBindingStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 编排任务角色
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskBindingRole {
    Task,
    Leader,
    Worker,
}

impl TaskBindingRole {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Task => "task",
            Self::Leader => "leader",
            Self::Worker => "worker",
        }
    }
}

impl std::str::FromStr for TaskBindingRole {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "task" => Ok(Self::Task),
            "leader" => Ok(Self::Leader),
            "worker" | "child" => Ok(Self::Worker),
            _ => Err(format!("Invalid TaskBindingRole: {}", s)),
        }
    }
}

impl std::fmt::Display for TaskBindingRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 编排任务绑定
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBinding {
    pub id: String,
    pub title: String,
    pub role: TaskBindingRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_plan_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todo_id: Option<String>,
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    pub cli_tool: String,
    pub status: TaskBindingStatus,
    pub progress: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub sort_order: i32,
    /// worker 类型：None = 普通实现 worker；"reviewer" = 评审员（可被 planreview 复用发现）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}

/// 创建编排任务请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskBindingRequest {
    pub title: String,
    #[serde(default)]
    pub role: Option<TaskBindingRole>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub plan_path: Option<String>,
    #[serde(default)]
    pub normalized_plan_path: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub resume_id: Option<String>,
    #[serde(default)]
    pub pane_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub todo_id: Option<String>,
    pub project_path: String,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub cli_tool: Option<String>,
    #[serde(default)]
    pub worker_kind: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// 更新编排任务请求
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskBindingRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub role: Option<TaskBindingRole>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub plan_path: Option<String>,
    #[serde(default)]
    pub normalized_plan_path: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub resume_id: Option<String>,
    #[serde(default)]
    pub pane_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub status: Option<TaskBindingStatus>,
    #[serde(default)]
    pub progress: Option<i32>,
    #[serde(default)]
    pub completion_summary: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub worker_kind: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// 查询编排任务请求
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskBindingQuery {
    #[serde(default)]
    pub status: Option<TaskBindingStatus>,
    #[serde(default)]
    pub role: Option<TaskBindingRole>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub plan_path: Option<String>,
    #[serde(default)]
    pub normalized_plan_path: Option<String>,
    #[serde(default)]
    pub resume_id: Option<String>,
    #[serde(default)]
    pub pane_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

/// 查询结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBindingQueryResult {
    pub items: Vec<TaskBinding>,
    pub total: u32,
    pub has_more: bool,
}

/// Plan 协作查询键
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanCollaborationKey {
    #[serde(default)]
    pub leader_id: Option<String>,
    #[serde(default)]
    pub plan_path: Option<String>,
    #[serde(default)]
    pub normalized_plan_path: Option<String>,
}

/// 登记 Plan leader 请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPlanLeaderRequest {
    pub plan_path: String,
    pub project_path: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub resume_id: Option<String>,
    #[serde(default)]
    pub pane_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub cli_tool: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// 登记 Plan worker 请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPlanWorkerRequest {
    #[serde(default)]
    pub leader_id: Option<String>,
    #[serde(default)]
    pub plan_path: Option<String>,
    pub session_id: String,
    pub project_path: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub resume_id: Option<String>,
    #[serde(default)]
    pub pane_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub cli_tool: Option<String>,
    /// worker 类型：省略 = 实现 worker；"reviewer" = 评审员（可被 planreview 复用发现）
    #[serde(default)]
    pub worker_kind: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// Plan 协作摘要项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCollaborationEntry {
    pub id: String,
    pub title: String,
    pub role: TaskBindingRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_plan_path: Option<String>,
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    pub cli_tool: String,
    pub status: TaskBindingStatus,
    pub progress: i32,
    /// worker 类型（常驻投影，不随 verbose 折叠）：None = 实现 worker；"reviewer" = 评审员
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub is_live: bool,
    pub can_relaunch: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}

/// Plan 协作查询结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCollaboration {
    pub leader: PlanCollaborationEntry,
    pub workers: Vec<PlanCollaborationEntry>,
    pub total: u32,
}

/// Backward-compatible alias for older callers during migration.
pub type RegisterPlanChildRequest = RegisterPlanWorkerRequest;

/// 当前活跃会话的位置快照，用于 reconcile
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanLiveSession {
    pub session_id: String,
    #[serde(default)]
    pub pane_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
}
