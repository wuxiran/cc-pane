//! 工作空间信息读取模块

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

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
    pub created_at: String,
    pub projects: Vec<WorkspaceProject>,
}

/// 从工作空间目录加载 workspace.json
pub fn load(workspace_dir: &str) -> Result<Workspace> {
    let workspace_json = Path::new(workspace_dir).join("workspace.json");
    let content = std::fs::read_to_string(&workspace_json)
        .with_context(|| format!("无法读取 workspace.json: {:?}", workspace_json))?;
    let workspace: Workspace = serde_json::from_str(&content)
        .with_context(|| "解析 workspace.json 失败")?;
    Ok(workspace)
}
