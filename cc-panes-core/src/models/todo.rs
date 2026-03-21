use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============ 枚举类型 ============

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Todo,
    InProgress,
    Done,
}

impl TodoStatus {
    pub fn as_str(&self) -> &str {
        match self {
            TodoStatus::Todo => "todo",
            TodoStatus::InProgress => "in_progress",
            TodoStatus::Done => "done",
        }
    }
}

impl std::str::FromStr for TodoStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "todo" => Ok(TodoStatus::Todo),
            "in_progress" => Ok(TodoStatus::InProgress),
            "done" => Ok(TodoStatus::Done),
            _ => Err(format!("Invalid TodoStatus: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TodoPriority {
    High,
    Medium,
    Low,
}

impl TodoPriority {
    pub fn as_str(&self) -> &str {
        match self {
            TodoPriority::High => "high",
            TodoPriority::Medium => "medium",
            TodoPriority::Low => "low",
        }
    }
}

impl std::str::FromStr for TodoPriority {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "high" => Ok(TodoPriority::High),
            "medium" => Ok(TodoPriority::Medium),
            "low" => Ok(TodoPriority::Low),
            _ => Err(format!("Invalid TodoPriority: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TodoScope {
    Global,
    Workspace,
    Project,
    External,
    TempScript,
}

impl TodoScope {
    pub fn as_str(&self) -> &str {
        match self {
            TodoScope::Global => "global",
            TodoScope::Workspace => "workspace",
            TodoScope::Project => "project",
            TodoScope::External => "external",
            TodoScope::TempScript => "temp_script",
        }
    }
}

impl std::str::FromStr for TodoScope {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "global" => Ok(TodoScope::Global),
            "workspace" => Ok(TodoScope::Workspace),
            "project" => Ok(TodoScope::Project),
            "external" => Ok(TodoScope::External),
            "temp_script" => Ok(TodoScope::TempScript),
            _ => Err(format!("Invalid TodoScope: {}", s)),
        }
    }
}

// ============ 主模型 ============

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: TodoStatus,
    pub priority: TodoPriority,
    pub scope: TodoScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_ref: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    pub my_day: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub my_day_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminder_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<String>,
    pub todo_type: String,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
    pub subtasks: Vec<TodoSubtask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoSubtask {
    pub id: String,
    pub todo_id: String,
    pub title: String,
    pub completed: bool,
    pub sort_order: i32,
    pub created_at: String,
}

// ============ 请求/查询类型 ============

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoRequest {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<TodoStatus>,
    #[serde(default)]
    pub priority: Option<TodoPriority>,
    #[serde(default)]
    pub scope: Option<TodoScope>,
    #[serde(default)]
    pub scope_ref: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub reminder_at: Option<String>,
    #[serde(default)]
    pub recurrence: Option<String>,
    #[serde(default)]
    pub todo_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<TodoStatus>,
    #[serde(default)]
    pub priority: Option<TodoPriority>,
    #[serde(default)]
    pub scope: Option<TodoScope>,
    #[serde(default)]
    pub scope_ref: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub my_day: Option<bool>,
    #[serde(default)]
    pub my_day_date: Option<String>,
    #[serde(default)]
    pub reminder_at: Option<String>,
    #[serde(default)]
    pub recurrence: Option<String>,
    #[serde(default)]
    pub todo_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TodoQuery {
    #[serde(default)]
    pub status: Option<TodoStatus>,
    #[serde(default)]
    pub priority: Option<TodoPriority>,
    #[serde(default)]
    pub scope: Option<TodoScope>,
    #[serde(default)]
    pub scope_ref: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub my_day: Option<bool>,
    #[serde(default)]
    pub todo_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoQueryResult {
    pub items: Vec<TodoItem>,
    pub total: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoStats {
    pub total: u32,
    pub by_status: HashMap<String, u32>,
    pub by_scope: HashMap<String, u32>,
    pub by_priority: HashMap<String, u32>,
    pub overdue: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_todo_status_round_trip() {
        let statuses = vec![TodoStatus::Todo, TodoStatus::InProgress, TodoStatus::Done];
        for status in statuses {
            let s = status.as_str();
            let parsed: TodoStatus = s.parse().unwrap();
            assert_eq!(parsed, status);
        }
    }

    #[test]
    fn test_todo_priority_round_trip() {
        let priorities = vec![TodoPriority::High, TodoPriority::Medium, TodoPriority::Low];
        for priority in priorities {
            let s = priority.as_str();
            let parsed: TodoPriority = s.parse().unwrap();
            assert_eq!(parsed, priority);
        }
    }

    #[test]
    fn test_todo_scope_round_trip() {
        let scopes = vec![
            TodoScope::Global,
            TodoScope::Workspace,
            TodoScope::Project,
            TodoScope::External,
            TodoScope::TempScript,
        ];
        for scope in scopes {
            let s = scope.as_str();
            let parsed: TodoScope = s.parse().unwrap();
            assert_eq!(parsed, scope);
        }
    }

    #[test]
    fn test_todo_item_json_camel_case() {
        let item = TodoItem {
            id: "test-id".to_string(),
            title: "Test".to_string(),
            description: None,
            status: TodoStatus::Todo,
            priority: TodoPriority::Medium,
            scope: TodoScope::Global,
            scope_ref: None,
            tags: vec!["rust".to_string()],
            due_date: None,
            my_day: false,
            my_day_date: None,
            reminder_at: None,
            recurrence: None,
            todo_type: String::new(),
            sort_order: 0,
            created_at: "2025-01-01T00:00:00Z".to_string(),
            updated_at: "2025-01-01T00:00:00Z".to_string(),
            subtasks: vec![],
        };
        let json = serde_json::to_string(&item).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value.get("createdAt").is_some());
        assert!(value.get("sortOrder").is_some());
        assert!(value.get("todoType").is_some());
        assert!(value.get("created_at").is_none());
    }

    #[test]
    fn test_create_request_defaults() {
        let json = r#"{"title": "My Task"}"#;
        let req: CreateTodoRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.title, "My Task");
        assert!(req.status.is_none());
        assert!(req.priority.is_none());
        assert!(req.scope.is_none());
    }

    #[test]
    fn test_todo_query_result_serialization() {
        let result = TodoQueryResult {
            items: vec![],
            total: 0,
            has_more: false,
        };
        let json = serde_json::to_string(&result).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value.get("hasMore").is_some());
    }

    #[test]
    fn test_todo_status_serde() {
        let json = r#""in_progress""#;
        let status: TodoStatus = serde_json::from_str(json).unwrap();
        assert_eq!(status, TodoStatus::InProgress);

        let serialized = serde_json::to_string(&status).unwrap();
        assert_eq!(serialized, r#""in_progress""#);
    }

    #[test]
    fn test_todo_scope_temp_script_serde() {
        let json = r#""temp_script""#;
        let scope: TodoScope = serde_json::from_str(json).unwrap();
        assert_eq!(scope, TodoScope::TempScript);
    }

    #[test]
    fn test_subtask_serialization() {
        let subtask = TodoSubtask {
            id: "sub-1".to_string(),
            todo_id: "todo-1".to_string(),
            title: "子任务".to_string(),
            completed: false,
            sort_order: 0,
            created_at: "2025-01-01T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&subtask).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value.get("todoId").is_some());
        assert!(value.get("sortOrder").is_some());
    }

    #[test]
    fn test_update_request_all_optional() {
        let json = r#"{}"#;
        let req: UpdateTodoRequest = serde_json::from_str(json).unwrap();
        assert!(req.title.is_none());
        assert!(req.status.is_none());
        assert!(req.tags.is_none());
    }
}
