use std::path::Path;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

use crate::models::{
    DiffResult, FileVersion, HistoryConfig, HistoryLabel, RecentChange, WorktreeRecentChange,
};
use crate::services::HistoryService;
use crate::utils::AppResult;

#[tauri::command]
pub async fn init_project_history(
    project_path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::init_project_history");
    history_service.init_project_history(Path::new(&project_path))?;
    Ok(())
}

#[tauri::command]
pub async fn list_file_versions(
    project_path: String,
    file_path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<Vec<FileVersion>> {
    let versions = history_service.list_versions(Path::new(&project_path), &file_path)?;
    Ok(versions)
}

#[tauri::command]
pub async fn get_version_content(
    project_path: String,
    file_path: String,
    version_id: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    let content =
        history_service.get_version_content(Path::new(&project_path), &file_path, &version_id)?;

    // 尝试 UTF-8 解码，失败尝试 GBK
    match String::from_utf8(content) {
        Ok(s) => Ok(s),
        Err(e) => {
            // 尝试 GBK 解码（中文 Windows 常见）
            let bytes = e.into_bytes();
            let (decoded, _, _) = encoding_rs::GBK.decode(&bytes);
            Ok(decoded.to_string())
        }
    }
}

#[tauri::command]
pub async fn restore_file_version(
    project_path: String,
    file_path: String,
    version_id: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<()> {
    debug!(file_path = %file_path, version_id = %version_id, "cmd::restore_file_version");
    history_service.restore_version(Path::new(&project_path), &file_path, &version_id)?;
    Ok(())
}

#[tauri::command]
pub async fn get_history_config(
    project_path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<HistoryConfig> {
    let config = history_service.get_config(Path::new(&project_path))?;
    Ok(config)
}

#[tauri::command]
pub async fn update_history_config(
    project_path: String,
    config: HistoryConfig,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::update_history_config");
    history_service.update_config(Path::new(&project_path), config)?;
    Ok(())
}

#[tauri::command]
pub async fn stop_project_history(
    project_path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::stop_project_history");
    history_service.stop_watching(Path::new(&project_path))?;
    Ok(())
}

#[tauri::command]
pub async fn cleanup_project_history(
    project_path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::cleanup_project_history");
    history_service.cleanup(Path::new(&project_path))?;
    Ok(())
}

// ============ Diff 命令 ============

#[tauri::command]
pub async fn get_version_diff(
    project_path: String,
    file_path: String,
    version_id: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<DiffResult> {
    let diff =
        history_service.get_version_diff(Path::new(&project_path), &file_path, &version_id)?;
    Ok(diff)
}

#[tauri::command]
pub async fn get_versions_diff(
    project_path: String,
    file_path: String,
    old_version_id: String,
    new_version_id: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<DiffResult> {
    let diff = history_service.get_versions_diff(
        Path::new(&project_path),
        &file_path,
        &old_version_id,
        &new_version_id,
    )?;
    Ok(diff)
}

// ============ 标签命令 ============

#[tauri::command]
pub async fn put_label(
    project_path: String,
    label: HistoryLabel,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, label_id = %label.id, "cmd::put_label");
    history_service.put_label(Path::new(&project_path), &label)?;
    Ok(())
}

#[tauri::command]
pub async fn list_labels(
    project_path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<Vec<HistoryLabel>> {
    let labels = history_service.list_labels(Path::new(&project_path))?;
    Ok(labels)
}

#[tauri::command]
pub async fn delete_label(
    project_path: String,
    label_id: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, label_id = %label_id, "cmd::delete_label");
    history_service.delete_label(Path::new(&project_path), &label_id)?;
    Ok(())
}

#[tauri::command]
pub async fn restore_to_label(
    project_path: String,
    label_id: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<Vec<String>> {
    debug!(project_path = %project_path, label_id = %label_id, "cmd::restore_to_label");
    let restored = history_service.restore_to_label(Path::new(&project_path), &label_id)?;
    Ok(restored)
}

#[tauri::command]
pub async fn create_auto_label(
    project_path: String,
    name: String,
    source: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    debug!(project_path = %project_path, name = %name, source = %source, "cmd::create_auto_label");
    let label_id = history_service.create_auto_label(Path::new(&project_path), &name, &source)?;
    Ok(label_id)
}

// ============ 目录级历史 + 最近更改 ============

#[tauri::command]
pub async fn list_directory_changes(
    project_path: String,
    dir_path: String,
    since: Option<String>,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<Vec<FileVersion>> {
    let changes = history_service.list_directory_changes(
        Path::new(&project_path),
        &dir_path,
        since.as_deref(),
    )?;
    Ok(changes)
}

#[tauri::command]
pub async fn get_recent_changes(
    project_path: String,
    limit: Option<usize>,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<Vec<RecentChange>> {
    let changes =
        history_service.get_recent_changes(Path::new(&project_path), limit.unwrap_or(50))?;
    Ok(changes)
}

// ============ 删除文件恢复 ============

#[tauri::command]
pub async fn list_deleted_files(
    project_path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<Vec<FileVersion>> {
    let files = history_service.list_deleted_files(Path::new(&project_path))?;
    Ok(files)
}

// ============ 压缩 ============

#[tauri::command]
pub async fn compress_history(
    project_path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<usize> {
    debug!(project_path = %project_path, "cmd::compress_history");
    let count = history_service.compress_blobs(Path::new(&project_path))?;
    Ok(count)
}

// ============ 分支感知命令 ============

#[tauri::command]
pub async fn get_current_branch(
    project_path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<String> {
    let branch = history_service.get_current_branch(Path::new(&project_path))?;
    Ok(branch)
}

#[tauri::command]
pub async fn get_file_branches(
    project_path: String,
    file_path: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<Vec<String>> {
    let branches = history_service.get_file_branches(Path::new(&project_path), &file_path)?;
    Ok(branches)
}

#[tauri::command]
pub async fn list_file_versions_by_branch(
    project_path: String,
    file_path: String,
    branch: String,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<Vec<FileVersion>> {
    let versions =
        history_service.list_versions_by_branch(Path::new(&project_path), &file_path, &branch)?;
    Ok(versions)
}

#[tauri::command]
pub async fn list_worktree_recent_changes(
    project_path: String,
    limit: Option<usize>,
    history_service: State<'_, Arc<HistoryService>>,
) -> AppResult<Vec<WorktreeRecentChange>> {
    let changes = history_service
        .list_worktree_recent_changes(Path::new(&project_path), limit.unwrap_or(50))?;
    Ok(changes)
}
