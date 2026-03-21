use serde::{Deserialize, Serialize};

/// 工作空间中的项目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub path: String,
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConnectionInfo>,
}

/// 工作空间
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub alias: Option<String>,
    pub created_at: String,
    pub projects: Vec<WorkspaceProject>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

impl Workspace {
    pub fn new(name: String, path: Option<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            alias: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            projects: Vec::new(),
            provider_id: None,
            path,
            pinned: false,
            hidden: false,
            sort_order: None,
        }
    }
}

impl WorkspaceProject {
    pub fn new(path: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            path,
            alias: None,
            ssh: None,
        }
    }
}

/// 扫描发现的 worktree 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedWorktree {
    pub path: String,
    pub branch: String,
}

/// 扫描发现的仓库信息（按主仓库分组）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedRepo {
    pub main_path: String,
    pub main_branch: String,
    pub worktrees: Vec<ScannedWorktree>,
}

fn default_ssh_port() -> u16 {
    22
}

/// SSH 连接信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionInfo {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub remote_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
}
