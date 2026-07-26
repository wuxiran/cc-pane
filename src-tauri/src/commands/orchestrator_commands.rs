use crate::services::orchestrator_service::{AiPanel, OrchestratorStatus};
use crate::services::OrchestratorService;
use crate::utils::error::{AppError, AppResult};
use cc_panes_core::models::ai_panel::{AiPanelSummary, StoredAiPanel};
use cc_panes_core::repository::AiPanelRepository;
use std::sync::Arc;
use tauri::State;

/// 获取 Orchestrator 服务器端口
#[tauri::command]
pub fn get_orchestrator_port(
    orchestrator: State<'_, Arc<OrchestratorService>>,
) -> AppResult<Option<u16>> {
    Ok(orchestrator.port())
}

/// 获取 Orchestrator 运行状态，供全局报警与设置页展示。
#[tauri::command]
pub fn get_orchestrator_status(
    orchestrator: State<'_, Arc<OrchestratorService>>,
) -> AppResult<OrchestratorStatus> {
    Ok(orchestrator.status())
}

/// 获取 Orchestrator 认证 Token
#[tauri::command]
pub fn get_orchestrator_token(
    orchestrator: State<'_, Arc<OrchestratorService>>,
) -> AppResult<String> {
    Ok(orchestrator.token().to_string())
}

/// 前端响应 MCP 查询请求
#[tauri::command]
pub fn respond_orchestrator_query(
    orchestrator: State<'_, Arc<OrchestratorService>>,
    request_id: String,
    data: String,
) -> AppResult<()> {
    let pending = orchestrator.pending_queries();
    let mut queries = pending.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = queries.remove(&request_id) {
        let _ = tx.send(data);
    }
    Ok(())
}

/// 获取当前进程内仍打开的 AI 面板，供前端启动时补领。
#[tauri::command]
pub fn list_ai_panels(
    orchestrator: State<'_, Arc<OrchestratorService>>,
) -> AppResult<Vec<AiPanel>> {
    Ok(orchestrator.list_ai_panels())
}

/// 列出全部历史 AI 面板摘要（不含正文），供右侧 Dock 按工作空间分组展示。
#[tauri::command]
pub fn list_ai_panel_history(
    repo: State<'_, Arc<AiPanelRepository>>,
) -> AppResult<Vec<AiPanelSummary>> {
    repo.list_summaries().map_err(AppError::from)
}

/// 按需取单个历史面板的正文。
///
/// 列表刻意不带 content（单个上限 256 KiB，历史又不自动清理），
/// 用户点开某一条时才拉这一条的正文。
#[tauri::command]
pub fn get_ai_panel_content(
    repo: State<'_, Arc<AiPanelRepository>>,
    panel_id: String,
) -> AppResult<Option<StoredAiPanel>> {
    repo.get(&panel_id).map_err(AppError::from)
}

/// 用户显式删除一条历史面板。历史不自动清理，这是唯一的删除入口。
#[tauri::command]
pub fn delete_ai_panel(
    repo: State<'_, Arc<AiPanelRepository>>,
    orchestrator: State<'_, Arc<OrchestratorService>>,
    panel_id: String,
) -> AppResult<bool> {
    orchestrator
        .delete_ai_panel(repo.inner().as_ref(), &panel_id)
        .map_err(AppError::from)
}

/// 记录 sandbox iframe 经宿主白名单校验后的用户操作事件。
#[tauri::command]
pub fn record_ai_panel_event(
    orchestrator: State<'_, Arc<OrchestratorService>>,
    panel_id: String,
    action: String,
    payload: Option<serde_json::Value>,
) -> AppResult<()> {
    orchestrator
        .record_ai_panel_event(&panel_id, &action, payload)
        .map_err(AppError::from)
}
