use crate::services::MemoryService;
use crate::utils::AppResult;
use cc_memory::models::*;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn search_memory(
    service: State<'_, Arc<MemoryService>>,
    query: MemoryQuery,
) -> AppResult<MemoryQueryResult> {
    Ok(service.search(query)?)
}

#[tauri::command]
pub fn store_memory(
    service: State<'_, Arc<MemoryService>>,
    request: StoreMemoryRequest,
) -> AppResult<Memory> {
    debug!("cmd::store_memory");
    Ok(service.store(request)?)
}

#[tauri::command]
pub fn list_memories(
    service: State<'_, Arc<MemoryService>>,
    scope: Option<MemoryScope>,
    workspace_name: Option<String>,
    project_path: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> AppResult<MemoryQueryResult> {
    Ok(service.list(
        scope,
        workspace_name.as_deref(),
        project_path.as_deref(),
        limit,
        offset,
    )?)
}

#[tauri::command]
pub fn get_memory(service: State<'_, Arc<MemoryService>>, id: String) -> AppResult<Option<Memory>> {
    Ok(service.get(&id)?)
}

#[tauri::command]
pub fn update_memory(
    service: State<'_, Arc<MemoryService>>,
    id: String,
    request: UpdateMemoryRequest,
) -> AppResult<bool> {
    debug!("cmd::update_memory id={}", id);
    Ok(service.update(&id, request)?)
}

#[tauri::command]
pub fn delete_memory(service: State<'_, Arc<MemoryService>>, id: String) -> AppResult<bool> {
    debug!("cmd::delete_memory id={}", id);
    Ok(service.delete(&id)?)
}

#[tauri::command]
pub fn get_memory_stats(
    service: State<'_, Arc<MemoryService>>,
    workspace_name: Option<String>,
    project_path: Option<String>,
) -> AppResult<MemoryStats> {
    Ok(service.stats(workspace_name.as_deref(), project_path.as_deref())?)
}

#[tauri::command]
pub fn prepare_session_context(
    service: State<'_, Arc<MemoryService>>,
    project_path: String,
    memory_ids: Vec<String>,
) -> AppResult<String> {
    Ok(service.prepare_session_context(&project_path, &memory_ids)?)
}

#[tauri::command]
pub fn format_memory_for_injection(
    service: State<'_, Arc<MemoryService>>,
    memory_ids: Vec<String>,
) -> AppResult<String> {
    Ok(service.format_for_injection(&memory_ids)?)
}
