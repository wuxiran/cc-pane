use axum::extract::Query;
use cc_panes_core::models::{SessionIndexEntry, SessionIndexListParams};
use cc_panes_core::repository::{Database, HistoryRepository, SessionIndexRepository};
use cc_panes_core::services::{LaunchHistoryService, SessionIndexService, WorkspaceService};
use serde_json::json;
use std::sync::Arc;

use super::*;

fn unique_missing_project_path(tag: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_millis();
    std::env::temp_dir()
        .join(format!(
            "cc-panes-web-agent-sessions-{tag}-{millis}-{}-missing",
            std::process::id()
        ))
        .to_string_lossy()
        .to_string()
}

#[tokio::test]
async fn list_claude_sessions_returns_empty_for_unknown_project() {
    let Json(sessions) = list_claude_sessions(Query(ProjectSessionsQuery {
        project_path: unique_missing_project_path("claude"),
        runtime_kind: None,
        wsl_distro: None,
        limit: None,
    }))
    .await
    .expect("list claude sessions");

    assert!(sessions.is_empty());
}

#[tokio::test]
async fn list_all_claude_sessions_honors_zero_limit() {
    let Json(sessions) = list_all_claude_sessions(Query(SessionLimitQuery { limit: Some(0) }))
        .await
        .expect("list all claude sessions");

    assert!(sessions.is_empty());
}

#[tokio::test]
async fn list_codex_sessions_returns_empty_for_unknown_project() {
    let Json(sessions) = list_codex_sessions(Query(ProjectSessionsQuery {
        project_path: unique_missing_project_path("codex"),
        runtime_kind: None,
        wsl_distro: None,
        limit: Some(5),
    }))
    .await
    .expect("list codex sessions");

    assert!(sessions.is_empty());
}

#[test]
fn project_sessions_query_uses_camel_case_field_names() {
    let query: ProjectSessionsQuery = serde_json::from_value(json!({
        "projectPath": "/repo",
        "runtimeKind": "wsl",
        "wslDistro": "Ubuntu",
        "limit": 3
    }))
    .expect("deserialize query");

    assert_eq!(query.project_path, "/repo");
    assert_eq!(query.runtime_kind.as_deref(), Some("wsl"));
    assert_eq!(query.wsl_distro.as_deref(), Some("Ubuntu"));
    assert_eq!(query.limit, Some(3));
}

fn index_entry(id: &str, cli_tool: &str, workspace: &str, mtime_ms: i64) -> SessionIndexEntry {
    SessionIndexEntry {
        session_id: id.to_string(),
        cli_tool: cli_tool.to_string(),
        file_path: format!("/sessions/{id}.jsonl"),
        cwd: "/workspace/project".to_string(),
        project_path_norm: "/workspace/project".to_string(),
        project_name: "project".to_string(),
        workspace_name: Some(workspace.to_string()),
        first_prompt: format!("first {id}"),
        last_summary: format!("summary {id}"),
        message_count: 4,
        mtime_ms,
        size: 128,
        source: "local".to_string(),
        wsl_distro: None,
        updated_at: "2026-07-25T00:00:00Z".to_string(),
    }
}

#[tokio::test]
async fn list_session_index_rest_logic_combines_filters_and_paging() {
    let db = Arc::new(Database::new_fallback().expect("database"));
    let repo = Arc::new(SessionIndexRepository::new(db.clone()));
    repo.upsert_session(&index_entry("claude-old", "claude", "main", 10))
        .expect("claude entry");
    repo.upsert_session(&index_entry("codex-new", "codex", "main", 20))
        .expect("codex entry");
    let service = SessionIndexService::new(
        repo,
        Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(
            db,
        )))),
        Arc::new(WorkspaceService::new(
            std::env::temp_dir().join(unique_missing_project_path("indexed-workspaces")),
        )),
    );

    let Json(entries) = list_session_index_with_service(
        &service,
        SessionIndexListParams {
            scope: Some("workspace".to_string()),
            workspace_name: Some("main".to_string()),
            query: Some("summary".to_string()),
            cli_filter: Some("codex".to_string()),
            limit: Some(1),
            offset: Some(0),
            ..SessionIndexListParams::default()
        },
    )
    .expect("list indexed sessions");

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].session_id, "codex-new");
}
