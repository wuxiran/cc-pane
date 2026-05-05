use crate::repository::LaunchRecord;
use crate::services::LaunchHistoryService;
use crate::utils::{encode_claude_project_path, AppResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tracing::debug;

/// Legacy directory-level session-state.json structure.
///
/// This file is kept for backward-compatible diagnostics/import paths only. It
/// is not the primary restore source; frontend restore should use the tab,
/// workspace snapshot, and launch history chain for exact agent resume IDs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    #[serde(default, alias = "claudeSessionId")]
    pub resume_session_id: Option<String>,
    pub cli_tool: Option<String>,
    pub runtime_kind: Option<String>,
    pub started_at: Option<String>,
    pub status: Option<String>,
    pub last_prompt: Option<String>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_launch_history(
    service: State<'_, Arc<LaunchHistoryService>>,
    project_id: String,
    project_name: String,
    project_path: String,
    cli_tool: Option<String>,
    runtime_kind: Option<String>,
    wsl_distro: Option<String>,
    workspace_name: Option<String>,
    workspace_path: Option<String>,
    launch_cwd: Option<String>,
    provider_id: Option<String>,
    provider_selection: Option<String>,
    launch_profile_id: Option<String>,
    workspace_snapshot_id: Option<String>,
) -> AppResult<i64> {
    debug!(project_name = %project_name, project_path = %project_path, "cmd::add_launch_history");
    Ok(service.add(
        &project_id,
        &project_name,
        &project_path,
        cli_tool.as_deref().unwrap_or("none"),
        runtime_kind.as_deref().unwrap_or("local"),
        wsl_distro.as_deref(),
        workspace_name.as_deref(),
        workspace_path.as_deref(),
        launch_cwd.as_deref(),
        provider_id.as_deref(),
        provider_selection.as_deref(),
        launch_profile_id.as_deref(),
        workspace_snapshot_id.as_deref(),
    )?)
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
pub fn clear_launch_history(service: State<'_, Arc<LaunchHistoryService>>) -> AppResult<()> {
    debug!("cmd::clear_launch_history");
    Ok(service.clear()?)
}

/// Legacy API: read a project's .ccpanes/session-state.json.
///
/// Do not use this as the main restore path. The file is directory-scoped and
/// may not identify the exact tab/snapshot/agent conversation being restored.
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
    resume_session_id: String,
) -> AppResult<()> {
    debug!(id = id, resume_session_id = %resume_session_id, "cmd::update_launch_session_id");
    Ok(service.update_session_id(id, &resume_session_id)?)
}

/// 更新已有会话记录的时间戳（resume 去重），返回记录 ID
#[tauri::command]
pub fn touch_launch_by_session(
    service: State<'_, Arc<LaunchHistoryService>>,
    resume_session_id: String,
) -> AppResult<Option<i64>> {
    debug!(resume_session_id = %resume_session_id, "cmd::touch_launch_by_session");
    Ok(service.touch_by_session_id(&resume_session_id)?)
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

fn detect_claude_session_inner(
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
        debug!(
            "[session-detect] path={} encoded={} dir={} exists={}",
            path,
            encoded,
            sessions_dir.display(),
            sessions_dir.is_dir()
        );
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

    debug!(
        "[session-detect] no session found for project_path={}",
        project_path
    );
    Ok(None)
}

fn detect_resume_session_inner(
    cli_tool: &str,
    runtime_kind: Option<&str>,
    wsl_distro: Option<&str>,
    project_path: String,
    workspace_path: Option<String>,
    after_ts: String,
) -> AppResult<Option<String>> {
    match cli_tool {
        "claude" => detect_claude_session_inner(project_path, workspace_path, after_ts),
        "codex" => {
            let after: DateTime<Utc> = DateTime::parse_from_rfc3339(&after_ts)
                .map_err(|e| format!("Invalid timestamp: {}", e))?
                .with_timezone(&Utc);

            let mut paths_to_try = Vec::new();
            if let Some(ref workspace_path) = workspace_path {
                paths_to_try.push(workspace_path.as_str());
            }
            paths_to_try.push(project_path.as_str());

            let runtime_kind = runtime_kind.unwrap_or("local");
            if runtime_kind == "wsl" {
                crate::services::codex_session_service::detect_wsl_session(
                    &paths_to_try,
                    after,
                    wsl_distro,
                )
                .map_err(|e| e.into())
            } else {
                crate::services::codex_session_service::detect_session(&paths_to_try, after)
                    .map_err(|e| e.into())
            }
        }
        _ => Ok(None),
    }
}

/// 从 CLI 对应的本地会话目录中扫描最近的 session ID。
/// after_ts: ISO 8601 时间戳，只返回在此时间之后修改的 session
#[tauri::command]
pub fn detect_resume_session(
    cli_tool: String,
    runtime_kind: Option<String>,
    wsl_distro: Option<String>,
    project_path: String,
    workspace_path: Option<String>,
    after_ts: String,
) -> AppResult<Option<String>> {
    detect_resume_session_inner(
        &cli_tool,
        runtime_kind.as_deref(),
        wsl_distro.as_deref(),
        project_path,
        workspace_path,
        after_ts,
    )
}

/// 兼容旧前端：继续保留 Claude 专用命令。
#[tauri::command]
pub fn detect_claude_session(
    project_path: String,
    workspace_path: Option<String>,
    after_ts: String,
) -> AppResult<Option<String>> {
    detect_claude_session_inner(project_path, workspace_path, after_ts)
}

/// 后端启动一个兜底回填任务，避免前端轮询 session 文件。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_launch_history_backfill(
    app_handle: AppHandle,
    service: State<'_, Arc<LaunchHistoryService>>,
    launch_id: String,
    pty_session_id: String,
    cli_tool: String,
    runtime_kind: String,
    wsl_distro: Option<String>,
    project_path: String,
    workspace_path: Option<String>,
    after_ts: Option<String>,
) -> AppResult<()> {
    let service = service.inner().clone();
    let after_ts = after_ts.unwrap_or_else(|| Utc::now().to_rfc3339());
    tauri::async_runtime::spawn(async move {
        for _ in 0..15 {
            if let Ok(Some(record)) = service.find_by_launch_id(&launch_id) {
                if record.resume_session_id.is_some() {
                    return;
                }
            }

            if let Ok(Some(resume_session_id)) = detect_resume_session_inner(
                &cli_tool,
                Some(&runtime_kind),
                wsl_distro.as_deref(),
                project_path.clone(),
                workspace_path.clone(),
                after_ts.clone(),
            ) {
                if let Ok(Some(record_id)) = service.update_session_started(
                    &launch_id,
                    &pty_session_id,
                    &resume_session_id,
                    &cli_tool,
                    &runtime_kind,
                    wsl_distro.as_deref(),
                    workspace_path.as_deref(),
                ) {
                    if let Ok(Some(last_prompt)) = crate::services::extract_last_prompt(
                        &cli_tool,
                        Some(&runtime_kind),
                        wsl_distro.as_deref(),
                        &project_path,
                        &resume_session_id,
                    ) {
                        let _ = service
                            .update_last_prompt_by_pty_session_id(&pty_session_id, &last_prompt);
                    }
                    let _ = app_handle.emit(
                        "history-updated",
                        serde_json::json!({
                            "source": "launch-backfill",
                            "recordId": record_id,
                            "launchId": launch_id,
                            "ptySessionId": pty_session_id,
                            "resumeSessionId": resume_session_id,
                        }),
                    );
                }
                return;
            }

            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
    Ok(())
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
