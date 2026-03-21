use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 项目数据模型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

impl Project {
    /// 从路径创建新项目
    pub fn new(path: &str) -> Self {
        let path_buf = PathBuf::from(path);
        let name = path_buf
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unnamed")
            .to_string();

        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            path: path.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            alias: None,
        }
    }
}
