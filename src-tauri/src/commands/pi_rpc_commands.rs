use crate::models::CreateSessionRequest;
use crate::services::{
    PiRpcCommandResponse, PiRpcEventBridge, PiRpcService, PiRpcSessionSnapshot, TerminalService,
};
use crate::utils::{AppError, AppResult};
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

/// Start a background Pi RPC process. The launch request intentionally reuses
/// the normal provider/profile resolution shape, while the optional binding
/// makes TaskBinding ownership explicit instead of inferred from a prompt.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRpcStartRequest {
    pub launch: CreateSessionRequest,
    #[serde(default)]
    pub task_binding_id: Option<String>,
}

#[tauri::command]
pub async fn start_pi_rpc_session(
    rpc_service: State<'_, Arc<PiRpcService>>,
    event_bridge: State<'_, Arc<PiRpcEventBridge>>,
    terminal_service: State<'_, Arc<TerminalService>>,
    request: PiRpcStartRequest,
) -> AppResult<PiRpcSessionSnapshot> {
    let binding_id = request
        .task_binding_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let initial_prompt = request.launch.initial_prompt.clone();
    let mut launch = request.launch;
    // Pi RPC accepts prompts through its JSONL command channel. Keeping the
    // command line prompt-free makes the first prompt observable and
    // correlated after the event bridge has subscribed.
    launch.initial_prompt = None;
    let spec = terminal_service.build_pi_rpc_launch_spec(&launch)?;
    let snapshot = rpc_service.start(spec).await?;

    if let Some(binding_id) = binding_id.as_deref() {
        if let Err(error) = event_bridge.attach_task_binding(binding_id, &snapshot.rpc_session_id) {
            let _ = rpc_service.stop(&snapshot.rpc_session_id).await;
            return Err(error);
        }
    }

    if let Err(error) = event_bridge
        .start_session(snapshot.rpc_session_id.clone(), binding_id.clone())
        .await
    {
        let _ = rpc_service.stop(&snapshot.rpc_session_id).await;
        return Err(error);
    }

    if let Some(message) = initial_prompt.filter(|message| !message.trim().is_empty()) {
        match rpc_service.prompt(&snapshot.rpc_session_id, message).await {
            Ok(response) if response.success => {}
            Ok(response) => {
                let _ = rpc_service.stop(&snapshot.rpc_session_id).await;
                return Err(AppError::coded(
                    "PI_RPC_INITIAL_PROMPT_REJECTED",
                    response
                        .error
                        .unwrap_or_else(|| "Pi rejected the initial prompt".to_string()),
                ));
            }
            Err(error) => {
                let _ = rpc_service.stop(&snapshot.rpc_session_id).await;
                return Err(error);
            }
        }
    }

    rpc_service.snapshot(&snapshot.rpc_session_id).await
}

#[tauri::command]
pub async fn list_pi_rpc_sessions(
    rpc_service: State<'_, Arc<PiRpcService>>,
) -> AppResult<Vec<PiRpcSessionSnapshot>> {
    Ok(rpc_service.list_sessions().await)
}

#[tauri::command]
pub async fn get_pi_rpc_session(
    rpc_service: State<'_, Arc<PiRpcService>>,
    rpc_session_id: String,
) -> AppResult<PiRpcSessionSnapshot> {
    rpc_service.snapshot(&rpc_session_id).await
}

#[tauri::command]
pub async fn prompt_pi_rpc_session(
    rpc_service: State<'_, Arc<PiRpcService>>,
    rpc_session_id: String,
    message: String,
) -> AppResult<PiRpcCommandResponse> {
    if message.trim().is_empty() {
        return Err(AppError::coded(
            "PI_RPC_PROMPT_REQUIRED",
            "Pi RPC prompt cannot be empty",
        ));
    }
    rpc_service.prompt(&rpc_session_id, message).await
}

#[tauri::command]
pub async fn abort_pi_rpc_session(
    rpc_service: State<'_, Arc<PiRpcService>>,
    rpc_session_id: String,
) -> AppResult<PiRpcCommandResponse> {
    rpc_service.abort(&rpc_session_id).await
}

#[tauri::command]
pub async fn get_pi_rpc_state(
    rpc_service: State<'_, Arc<PiRpcService>>,
    rpc_session_id: String,
) -> AppResult<PiRpcCommandResponse> {
    rpc_service.get_state(&rpc_session_id).await
}

#[tauri::command]
pub async fn stop_pi_rpc_session(
    rpc_service: State<'_, Arc<PiRpcService>>,
    rpc_session_id: String,
) -> AppResult<PiRpcSessionSnapshot> {
    rpc_service.stop(&rpc_session_id).await
}
