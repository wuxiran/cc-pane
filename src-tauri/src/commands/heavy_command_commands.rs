//! 重负载命令台账（docs/107 P2b）的 Tauri 命令。
//!
//! 只读查询 + 清空；写入全部由 `HeavyCommandRecorder` / `HeavyCommandSampler` 后台完成。

use crate::services::heavy_command_sampler::HeavyCommandSampler;
use crate::utils::{AppError, AppResult};
use cc_panes_core::models::{
    HeavyCommandAggregate, HeavyCommandQuery, HeavyCommandRecord, HeavySamplerStats,
};
use cc_panes_core::repository::HeavyCommandsRepository;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn list_heavy_commands(
    query: Option<HeavyCommandQuery>,
    repo: State<'_, Arc<HeavyCommandsRepository>>,
) -> AppResult<Vec<HeavyCommandRecord>> {
    let repo = repo.inner().clone();
    let query = query.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || repo.list(&query).map_err(AppError::from))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub async fn aggregate_heavy_commands(
    since: Option<i64>,
    project_path: Option<String>,
    repo: State<'_, Arc<HeavyCommandsRepository>>,
) -> AppResult<Vec<HeavyCommandAggregate>> {
    let repo = repo.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        repo.aggregate(since, project_path.as_deref())
            .map_err(AppError::from)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub async fn clear_heavy_commands(
    repo: State<'_, Arc<HeavyCommandsRepository>>,
) -> AppResult<usize> {
    let repo = repo.inner().clone();
    tauri::async_runtime::spawn_blocking(move || repo.clear_all().map_err(AppError::from))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub fn get_heavy_sampler_stats(sampler: State<'_, Arc<HeavyCommandSampler>>) -> HeavySamplerStats {
    sampler.stats()
}
