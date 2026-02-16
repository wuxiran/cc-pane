use serde::{Deserialize, Serialize};

/// 工作空间中的项目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceProject {
    pub id: String,
    pub path: String,
    pub alias: Option<String>,
}

/// 工作空间
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub alias: Option<String>,
    pub created_at: String,
    pub projects: Vec<WorkspaceProject>,
    #[serde(default)]
    pub provider_id: Option<String>,
}

impl Workspace {
    pub fn new(name: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            alias: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            projects: Vec::new(),
            provider_id: None,
        }
    }
}

impl WorkspaceProject {
    pub fn new(path: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            path,
            alias: None,
        }
    }
}

/// 扫描发现的 worktree 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannedWorktree {
    pub path: String,
    pub branch: String,
}

/// 扫描发现的仓库信息（按主仓库分组）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannedRepo {
    pub main_path: String,
    pub main_branch: String,
    pub worktrees: Vec<ScannedWorktree>,
}
