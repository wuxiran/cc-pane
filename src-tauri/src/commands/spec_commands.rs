use crate::models::spec::*;
use crate::services::SpecService;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;
use tracing::{debug, info, warn};

#[tauri::command]
pub fn create_spec(
    service: State<'_, Arc<SpecService>>,
    request: CreateSpecRequest,
) -> AppResult<SpecEntry> {
    debug!("cmd::create_spec");
    service.create_spec(request)
}

#[tauri::command]
pub fn list_specs(
    service: State<'_, Arc<SpecService>>,
    project_path: String,
    status: Option<SpecStatus>,
) -> AppResult<Vec<SpecEntry>> {
    service.list_specs(&project_path, status)
}

#[tauri::command]
pub fn get_spec_content(
    service: State<'_, Arc<SpecService>>,
    project_path: String,
    spec_id: String,
) -> AppResult<String> {
    service.get_spec_content(&project_path, &spec_id)
}

#[tauri::command]
pub fn save_spec_content(
    service: State<'_, Arc<SpecService>>,
    project_path: String,
    spec_id: String,
    content: String,
) -> AppResult<()> {
    debug!(spec_id = %spec_id, "cmd::save_spec_content");
    service.save_spec_content(&project_path, &spec_id, &content)
}

#[tauri::command]
pub fn update_spec(
    service: State<'_, Arc<SpecService>>,
    spec_id: String,
    request: UpdateSpecRequest,
) -> AppResult<SpecEntry> {
    debug!(spec_id = %spec_id, "cmd::update_spec");
    service.update_spec(&spec_id, request)
}

#[tauri::command]
pub fn delete_spec(
    service: State<'_, Arc<SpecService>>,
    project_path: String,
    spec_id: String,
) -> AppResult<()> {
    debug!(spec_id = %spec_id, "cmd::delete_spec");
    service.delete_spec(&project_path, &spec_id)
}

#[tauri::command]
pub fn sync_spec_tasks(
    service: State<'_, Arc<SpecService>>,
    project_path: String,
    spec_id: String,
) -> AppResult<()> {
    debug!(spec_id = %spec_id, "cmd::sync_spec_tasks");
    service.sync_tasks(&project_path, &spec_id)
}

/// 终端退出时的 Spec 处理：sync_tasks → git diff --stat HEAD → append_log
#[tauri::command]
pub fn handle_terminal_exit_spec(
    service: State<'_, Arc<SpecService>>,
    project_path: String,
) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::handle_terminal_exit_spec");

    // 1. 查询 active spec
    let active = match service.list_specs(&project_path, Some(SpecStatus::Active))? {
        specs if specs.is_empty() => return Ok(()),
        mut specs => specs.remove(0),
    };

    // 2. sync_tasks（回收 AI 的 checkbox 改动）
    if let Err(e) = service.sync_tasks(&project_path, &active.id) {
        warn!("[spec] sync_tasks on exit failed: {}", e);
    }

    // 3. git diff --stat HEAD（使用 output_with_timeout 自动设置 CREATE_NO_WINDOW）
    let diff_output = match cc_panes_core::utils::output_with_timeout(
        std::process::Command::new("git")
            .args(["diff", "--stat", "HEAD"])
            .current_dir(&project_path),
        cc_panes_core::utils::GIT_LOCAL_TIMEOUT,
    ) {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
        Err(e) => {
            warn!("[spec] git diff failed: {}", e);
            return Ok(());
        }
    };

    // 4. 若 diff 为空 → 跳过
    if diff_output.is_empty() {
        debug!("[spec] No git changes, skipping log append");
        return Ok(());
    }

    // 5. append_log
    info!("[spec] Appending git diff to spec log for {}", active.id);
    if let Err(e) = service.append_log(&project_path, &active.id, &diff_output) {
        warn!("[spec] append_log failed: {}", e);
    }

    Ok(())
}
