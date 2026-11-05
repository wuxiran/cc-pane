//! 资源库「技能」命令（docs/109 第 2 批）。REST 对应 `cc-panes-web/src/routes/skill_library.rs`。

use crate::utils::{AppError, AppResult};
use cc_panes_core::models::skill_library::{
    FoundSkill, LibrarySkill, SkillCheck, SkillImportResult, SkillInstallResult,
    SkillLibraryContent, SkillProbe, SkillRemoveResult, SkillUpdateResult,
};
use cc_panes_core::services::SkillLibraryService;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// 文件系统密集的操作（哈希、复制、移动）放到阻塞线程池，别占住 IPC 线程。
async fn blocking<T, F>(service: &State<'_, Arc<SkillLibraryService>>, work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&SkillLibraryService) -> AppResult<T> + Send + 'static,
{
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || work(&service))
        .await
        .map_err(|error| AppError::from(format!("Skill library task failed: {}", error)))?
}

#[tauri::command]
pub async fn skill_library_list(
    service: State<'_, Arc<SkillLibraryService>>,
) -> AppResult<Vec<LibrarySkill>> {
    blocking(&service, |service| service.list()).await
}

#[tauri::command]
pub async fn skill_library_read(
    id: String,
    service: State<'_, Arc<SkillLibraryService>>,
) -> AppResult<SkillLibraryContent> {
    blocking(&service, move |service| service.read(&id)).await
}

#[tauri::command]
pub async fn skill_library_probe(
    source: String,
    service: State<'_, Arc<SkillLibraryService>>,
) -> AppResult<SkillProbe> {
    debug!(source = %source, "cmd::skill_library_probe");
    service.probe(&source).await
}

#[tauri::command]
pub async fn skill_library_install(
    probe_id: String,
    paths: Vec<String>,
    service: State<'_, Arc<SkillLibraryService>>,
) -> AppResult<SkillInstallResult> {
    debug!(probe_id = %probe_id, count = paths.len(), "cmd::skill_library_install");
    service.install(&probe_id, &paths).await
}

#[tauri::command]
pub async fn skill_library_check(
    ids: Option<Vec<String>>,
    service: State<'_, Arc<SkillLibraryService>>,
) -> AppResult<Vec<SkillCheck>> {
    service.check(ids.as_deref()).await
}

#[tauri::command]
pub async fn skill_library_update(
    ids: Vec<String>,
    replace_edited: bool,
    service: State<'_, Arc<SkillLibraryService>>,
) -> AppResult<SkillUpdateResult> {
    debug!(ids = ?ids, replace_edited, "cmd::skill_library_update");
    service.update(&ids, replace_edited).await
}

#[tauri::command]
pub async fn skill_library_remove(
    ids: Vec<String>,
    service: State<'_, Arc<SkillLibraryService>>,
) -> AppResult<SkillRemoveResult> {
    debug!(ids = ?ids, "cmd::skill_library_remove");
    blocking(&service, move |service| service.remove(&ids)).await
}

#[tauri::command]
pub async fn skill_library_found(
    service: State<'_, Arc<SkillLibraryService>>,
) -> AppResult<Vec<FoundSkill>> {
    blocking(&service, |service| service.found()).await
}

#[tauri::command]
pub async fn skill_library_import(
    keys: Vec<String>,
    service: State<'_, Arc<SkillLibraryService>>,
) -> AppResult<SkillImportResult> {
    debug!(count = keys.len(), "cmd::skill_library_import");
    blocking(&service, move |service| service.import(&keys)).await
}
