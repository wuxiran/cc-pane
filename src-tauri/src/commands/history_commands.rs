use crate::repository::LaunchRecord;
use crate::services::LaunchHistoryService;
use crate::utils::{encode_claude_project_path, AppResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// session-state.json 的结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub claude_session_id: Option<String>,
    pub started_at: Option<String>,
    pub status: Option<String>,
    pub last_prompt: Option<String>,
}

#[tauri::command]
pub fn add_launch_history(
    service: State<'_, Arc<LaunchHistoryService>>,
    project_id: String,
    project_name: String,
    project_path: String,
    workspace_name: Option<String>,
    workspace_path: Option<String>,
    launch_cwd: Option<String>,
) -> AppResult<i64> {
    debug!(project_name = %project_name, project_path = %project_path, "cmd::add_launch_history");
    Ok(service.add(&project_id, &project_name, &project_path, workspace_name.as_deref(), workspace_path.as_deref(), launch_cwd.as_deref())?)
}

#[tauri::command]
pub fn list_launch_history(
    service: State<'_, Arc<LaunchHistoryService>>,
    limit: Option<usize>,
) -> AppResult<Vec<LaunchRecord>> {
    Ok(service.list(limit.unwrap_or(20))?)
}

#[tauri::command]
pub fn delete_launch_history(
    service: State<'_, Arc<LaunchHistoryService>>,
    id: i64,
) -> AppResult<()> {
    debug!(id = id, "cmd::delete_launch_history");
    Ok(service.delete(id)?)
}

#[tauri::command]
pub fn clear_launch_history(
    service: State<'_, Arc<LaunchHistoryService>>,
) -> AppResult<()> {
    debug!("cmd::clear_launch_history");
    Ok(service.clear()?)
}

/// 读取项目的 session-state.json
#[tauri::command]
pub fn read_session_state(project_path: String) -> AppResult<Option<SessionState>> {
    let state_path = PathBuf::from(&project_path)
        .join(".ccpanes")
        .join("session-state.json");

    if !state_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&state_path)
        .map_err(|e| format!("Failed to read session-state.json: {}", e))?;

    let state: SessionState = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse session-state.json: {}", e))?;

    Ok(Some(state))
}

/// 更新启动记录的 Claude Session ID
#[tauri::command]
pub fn update_launch_session_id(
    service: State<'_, Arc<LaunchHistoryService>>,
    id: i64,
    claude_session_id: String,
) -> AppResult<()> {
    debug!(id = id, claude_session_id = %claude_session_id, "cmd::update_launch_session_id");
    Ok(service.update_session_id(id, &claude_session_id)?)
}

/// 更新已有会话记录的时间戳（resume 去重），返回记录 ID
#[tauri::command]
pub fn touch_launch_by_session(
    service: State<'_, Arc<LaunchHistoryService>>,
    claude_session_id: String,
) -> AppResult<Option<i64>> {
    debug!(claude_session_id = %claude_session_id, "cmd::touch_launch_by_session");
    Ok(service.touch_by_session_id(&claude_session_id)?)
}

/// 更新启动记录的最后 Prompt
#[tauri::command]
pub fn update_launch_last_prompt(
    service: State<'_, Arc<LaunchHistoryService>>,
    id: i64,
    last_prompt: String,
) -> AppResult<()> {
    debug!(id = id, "cmd::update_launch_last_prompt");
    Ok(service.update_last_prompt(id, &last_prompt)?)
}

/// 从 ~/.claude/projects/ 扫描最近的 session ID
/// after_ts: ISO 8601 时间戳，只返回在此时间之后修改的 session
#[tauri::command]
pub fn detect_claude_session(
    project_path: String,
    workspace_path: Option<String>,
    after_ts: String,
) -> AppResult<Option<String>> {
    let after: DateTime<Utc> = DateTime::parse_from_rfc3339(&after_ts)
        .map_err(|e| format!("Invalid timestamp: {}", e))?
        .with_timezone(&Utc);

    // 尝试多个路径：workspace_path 优先，project_path 作为 fallback
    let mut paths_to_try = Vec::new();
    if let Some(ref ws) = workspace_path {
        paths_to_try.push(ws.as_str());
    }
    paths_to_try.push(&project_path);

    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;

    for path in paths_to_try {
        let encoded = encode_claude_project_path(path);
        let sessions_dir = home.join(".claude").join("projects").join(&encoded);
        debug!("[session-detect] path={} encoded={} dir={} exists={}", path, encoded, sessions_dir.display(), sessions_dir.is_dir());
        if !sessions_dir.is_dir() {
            continue;
        }

        let mut latest: Option<(String, std::time::SystemTime)> = None;
        if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let stem = p
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if uuid::Uuid::parse_str(&stem).is_err() {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        let modified_dt: DateTime<Utc> = modified.into();
                        if modified_dt < after {
                            continue;
                        }
                        if latest.as_ref().map(|(_, t)| modified > *t).unwrap_or(true) {
                            latest = Some((stem, modified));
                        }
                    }
                }
            }
        }
        if let Some((id, _)) = latest {
            debug!("[session-detect] found session_id={} for path={}", id, path);
            return Ok(Some(id));
        }
    }

    debug!("[session-detect] no session found for project_path={}", project_path);
    Ok(None)
}

/// 诊断命令：返回路径编码结果，用于 DevTools 验证
#[tauri::command]
pub fn debug_encode_path(path: String) -> AppResult<serde_json::Value> {
    let encoded = encode_claude_project_path(&path);
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let expected_dir = home.join(".claude").join("projects").join(&encoded);
    let dir_exists = expected_dir.is_dir();

    Ok(serde_json::json!({
        "input": path,
        "encoded": encoded,
        "expected_dir": expected_dir.to_string_lossy(),
        "dir_exists": dir_exists,
    }))
}
