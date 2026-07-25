use crate::services::orchestrator_service::{AiPanel, OrchestratorBindDecision};
use crate::services::OrchestratorService;
use crate::utils::error::{AppError, AppResult};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

/// 获取 Orchestrator 服务器端口
#[tauri::command]
pub fn get_orchestrator_port(
    orchestrator: State<'_, Arc<OrchestratorService>>,
) -> AppResult<Option<u16>> {
    Ok(orchestrator.port())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStatus {
    pub port: Option<u16>,
    pub bind: Option<OrchestratorBindDecision>,
}

/// 获取 Orchestrator 运行状态（端口 + 绑定决策，供设置页展示）
#[tauri::command]
pub fn get_orchestrator_status(
    orchestrator: State<'_, Arc<OrchestratorService>>,
) -> AppResult<OrchestratorStatus> {
    Ok(OrchestratorStatus {
        port: orchestrator.port(),
        bind: orchestrator.bind_decision(),
    })
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
