use crate::services::OrchestratorService;
use crate::utils::error::AppResult;
use std::sync::Arc;
use tauri::State;

/// 获取 Orchestrator 服务器端口
#[tauri::command]
pub fn get_orchestrator_port(
    orchestrator: State<'_, Arc<OrchestratorService>>,
) -> AppResult<Option<u16>> {
    Ok(orchestrator.port())
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
