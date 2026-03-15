use serde::{Deserialize, Serialize};

// ============ 枚举类型 ============

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SpecStatus {
    Draft,
    Active,
    Archived,
}

impl SpecStatus {
    pub fn as_str(&self) -> &str {
        match self {
            SpecStatus::Draft => "draft",
            SpecStatus::Active => "active",
            SpecStatus::Archived => "archived",
        }
    }
}

impl std::str::FromStr for SpecStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "draft" => Ok(SpecStatus::Draft),
            "active" => Ok(SpecStatus::Active),
            "archived" => Ok(SpecStatus::Archived),
            _ => Err(format!("Invalid SpecStatus: {}", s)),
        }
    }
}

// ============ 主模型 ============

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecEntry {
    pub id: String,
    pub project_path: String,
    pub title: String,
    pub file_name: String,
    pub status: SpecStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todo_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

// ============ 请求类型 ============

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpecRequest {
    pub project_path: String,
    pub title: String,
    /// 初始任务列表（可选，创建时同步生成 Todo 子任务）
    #[serde(default)]
    pub tasks: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSpecRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub status: Option<SpecStatus>,
}

/// Spec 摘要（用于终端注入）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecSummary {
    pub spec_id: String,
    pub title: String,
    pub file_path: String,
    pub tasks_summary: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spec_status_round_trip() {
        let statuses = vec![SpecStatus::Draft, SpecStatus::Active, SpecStatus::Archived];
        for status in statuses {
            let s = status.as_str();
            let parsed: SpecStatus = s.parse().unwrap();
            assert_eq!(parsed, status);
        }
    }

    #[test]
    fn test_spec_status_serde() {
        let json = r#""active""#;
        let status: SpecStatus = serde_json::from_str(json).unwrap();
        assert_eq!(status, SpecStatus::Active);

        let serialized = serde_json::to_string(&status).unwrap();
        assert_eq!(serialized, r#""active""#);
    }

    #[test]
    fn test_spec_entry_json_camel_case() {
        let entry = SpecEntry {
            id: "test-id".to_string(),
            project_path: "/path/to/project".to_string(),
            title: "Add dark mode".to_string(),
            file_name: "add-dark-mode.spec.md".to_string(),
            status: SpecStatus::Draft,
            todo_id: None,
            created_at: "2026-03-15T00:00:00Z".to_string(),
            updated_at: "2026-03-15T00:00:00Z".to_string(),
            archived_at: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value.get("projectPath").is_some());
        assert!(value.get("fileName").is_some());
        assert!(value.get("createdAt").is_some());
        assert!(value.get("project_path").is_none());
    }

    #[test]
    fn test_create_spec_request_defaults() {
        let json = r#"{"projectPath": "/path", "title": "My Spec"}"#;
        let req: CreateSpecRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.title, "My Spec");
        assert!(req.tasks.is_none());
    }

    #[test]
    fn test_update_spec_request_all_optional() {
        let json = r#"{}"#;
        let req: UpdateSpecRequest = serde_json::from_str(json).unwrap();
        assert!(req.title.is_none());
        assert!(req.status.is_none());
    }
}
