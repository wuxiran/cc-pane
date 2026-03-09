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
