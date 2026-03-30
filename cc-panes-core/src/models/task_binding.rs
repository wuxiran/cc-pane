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

/// 编排任务绑定
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBinding {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
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
    pub created_at: String,
    pub updated_at: String,
}

/// 创建编排任务请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskBindingRequest {
    pub title: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub todo_id: Option<String>,
    pub project_path: String,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub cli_tool: Option<String>,
}

/// 更新编排任务请求
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskBindingRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
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
}

/// 查询编排任务请求
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskBindingQuery {
    #[serde(default)]
    pub status: Option<TaskBindingStatus>,
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
