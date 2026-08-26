//! Tauri commands for the durable media canvas surface.
//!
//! Provider execution is intentionally outside this module.  Commands delegate
//! to the shared `MediaService`, which keeps desktop and web callers on the
//! same validation and persistence path.

use crate::services::{ComfyRuntimeService, COMFY_LOCAL_PROVIDER_ID};
use crate::utils::AppResult;
use cc_panes_core::models::{
    CreateMediaAssetRequest, CreateMediaEdgeRequest, CreateMediaNodeRequest, CreateMediaRunRequest,
    MediaAsset, MediaEdge, MediaNode, MediaQueueSnapshot, MediaRun, MediaRunStatus,
    MediaSchedulerSnapshot, ReplayMediaRunRequest, StageMediaInputRequest, UpdateMediaNodeRequest,
};
use cc_panes_core::services::{
    apply_media_run_protocol, shared_comfy_adapter_cache, ComfyMediaAdapter,
    ComfyObjectInfoResponse, ComfySystemStats, MediaProtocol, MediaProviderAdapter,
    MediaProviderCapabilities, MediaProviderProfile, OpenAiCompatibleMediaAdapter, ProviderService,
    COMFY_OBJECT_INFO_SCHEMA_VERSION,
};
use cc_panes_core::services::{MediaJobWorker, MediaService};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use urlencoding::encode;

fn require_comfy_runtime_ready(status: &crate::services::ComfyRuntimeStatus) -> AppResult<()> {
    if !status.running || !status.ready {
        return Err(cc_panes_core::utils::error::AppError::coded(
            "COMFY_RUNTIME_NOT_READY",
            "Local ComfyUI engine is not ready",
        ));
    }
    Ok(())
}

fn comfy_adapter_for_provider(
    provider_id: &str,
    providers: &ProviderService,
    runtime: &ComfyRuntimeService,
) -> AppResult<Arc<ComfyMediaAdapter>> {
    if provider_id == COMFY_LOCAL_PROVIDER_ID {
        let status = runtime.status();
        require_comfy_runtime_ready(&status)?;
        return shared_comfy_adapter_cache().adapter_for_profile(runtime.adapter_profile()?);
    }
    let provider = providers.get_provider(provider_id).ok_or_else(|| {
        cc_panes_core::utils::error::AppError::coded(
            "COMFY_PROVIDER_NOT_FOUND",
            "ComfyUI provider was not found",
        )
    })?;
    shared_comfy_adapter_cache().adapter_for_provider(&provider)
}

fn provider_execution_config_fingerprint(
    node_id: &str,
    request: &serde_json::Value,
    service: &MediaService,
    providers: &ProviderService,
    runtime: &ComfyRuntimeService,
) -> AppResult<Option<String>> {
    let Some(node) = service.get_node(node_id)? else {
        return Ok(None);
    };
    let Some(provider_ref) = node.provider_ref.as_ref() else {
        return Ok(None);
    };
    let profile = if provider_ref.provider_id == COMFY_LOCAL_PROVIDER_ID {
        let local_profile = match runtime.adapter_profile() {
            Ok(profile) => profile,
            Err(error) if error.code() == Some("COMFY_RUNTIME_NOT_STARTED") => return Ok(None),
            Err(error) => return Err(error),
        };
        MediaProviderProfile::new(local_profile.id, local_profile.base_url, None)?
            .with_protocol(MediaProtocol::ComfyUi)
    } else {
        let Some(provider) = providers.get_provider(&provider_ref.provider_id) else {
            // A manually registered adapter has no ProviderService snapshot.
            // Preserve its existing cache behavior instead of rejecting it.
            return Ok(None);
        };
        MediaProviderProfile::from_provider(&provider)?
    };
    let profile = apply_media_run_protocol(profile, &node.parameters, request)?;
    Ok(Some(profile.execution_config_fingerprint()?))
}

fn provider_execution_config_fingerprint_for_run(
    run_id: &str,
    service: &MediaService,
    providers: &ProviderService,
    runtime: &ComfyRuntimeService,
) -> AppResult<Option<String>> {
    let Some(run) = service.get_run(run_id)? else {
        return Ok(None);
    };
    provider_execution_config_fingerprint(&run.node_id, &run.request, service, providers, runtime)
}

/// Discover the live ComfyUI node schema through the same adapter boundary
/// used by the media worker. The local engine is resolved from its managed
/// runtime; remote engines are resolved from the existing ProviderService.
#[tauri::command]
pub async fn get_comfy_object_info(
    provider_id: String,
    class_type: Option<String>,
    refresh: Option<bool>,
    providers: State<'_, Arc<ProviderService>>,
    runtime: State<'_, Arc<ComfyRuntimeService>>,
) -> AppResult<ComfyObjectInfoResponse> {
    let adapter = comfy_adapter_for_provider(&provider_id, &providers, &runtime)?;
    if refresh.unwrap_or(false) {
        adapter.clear_object_info_cache();
    }
    let (schema, schema_fingerprint) = adapter.object_info().await?;
    let node = match class_type.as_deref() {
        Some(class_type) => adapter.object_info_for_node(class_type).await?,
        None => None,
    };
    Ok(ComfyObjectInfoResponse {
        provider_id,
        schema_fingerprint,
        schema_version: COMFY_OBJECT_INFO_SCHEMA_VERSION.to_string(),
        schema,
        node,
    })
}

/// Return the normalized capability contract for the selected media protocol.
/// The protocol is explicit because the shared Provider record is also used by
/// CLI launchers and therefore does not own a media-only protocol field.
#[tauri::command]
pub fn get_media_provider_capabilities(
    provider_id: String,
    protocol: Option<String>,
    providers: State<'_, Arc<ProviderService>>,
    runtime: State<'_, Arc<ComfyRuntimeService>>,
) -> AppResult<MediaProviderCapabilities> {
    if provider_id == COMFY_LOCAL_PROVIDER_ID {
        return Ok(comfy_adapter_for_provider(&provider_id, &providers, &runtime)?.capabilities());
    }
    let provider = providers.get_provider(&provider_id).ok_or_else(|| {
        cc_panes_core::utils::error::AppError::coded(
            "MEDIA_PROVIDER_NOT_FOUND",
            "media provider was not found",
        )
    })?;
    let protocol = protocol
        .as_deref()
        .unwrap_or("open_ai_compatible")
        .parse::<MediaProtocol>()
        .map_err(|message| {
            cc_panes_core::utils::error::AppError::coded("MEDIA_PROTOCOL_INVALID", message)
        })?;
    match protocol {
        MediaProtocol::ComfyUi => Ok(shared_comfy_adapter_cache()
            .adapter_for_provider(&provider)?
            .capabilities()),
        protocol => Ok(OpenAiCompatibleMediaAdapter::new(
            MediaProviderProfile::from_provider(&provider)?.with_protocol(protocol),
        )?
        .capabilities()),
    }
}

/// Fetch the normalized ComfyUI resource snapshot for local or configured
/// remote providers. The adapter keeps the wire-level schema out of Tauri.
#[tauri::command]
pub async fn get_comfy_system_stats(
    provider_id: String,
    providers: State<'_, Arc<ProviderService>>,
    runtime: State<'_, Arc<ComfyRuntimeService>>,
) -> AppResult<ComfySystemStats> {
    comfy_adapter_for_provider(&provider_id, &providers, &runtime)?
        .system_stats()
        .await
}

#[tauri::command]
pub async fn free_comfy_memory(
    provider_id: String,
    unload_models: bool,
    free_memory: bool,
    providers: State<'_, Arc<ProviderService>>,
    runtime: State<'_, Arc<ComfyRuntimeService>>,
) -> AppResult<cc_panes_core::services::ComfyMemoryReleaseResult> {
    let adapter = comfy_adapter_for_provider(&provider_id, &providers, &runtime)?;
    adapter.free_memory(unload_models, free_memory).await?;
    Ok(cc_panes_core::services::ComfyMemoryReleaseResult {
        provider_id,
        unload_models,
        free_memory,
        accepted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(running: bool, ready: bool) -> crate::services::ComfyRuntimeStatus {
        crate::services::ComfyRuntimeStatus {
            enabled: true,
            running,
            pid: None,
            port: 8188,
            base_url: "http://127.0.0.1:8188/".to_string(),
            root: None,
            python: None,
            startup_error: None,
            ready,
            readiness: "starting".to_string(),
            readiness_error: None,
            stderr: None,
        }
    }

    #[test]
    fn local_runtime_capabilities_require_http_readiness() {
        let error =
            require_comfy_runtime_ready(&status(false, false)).expect_err("stopped runtime");
        assert_eq!(error.code(), Some("COMFY_RUNTIME_NOT_READY"));
        let error =
            require_comfy_runtime_ready(&status(true, false)).expect_err("starting runtime");
        assert_eq!(error.code(), Some("COMFY_RUNTIME_NOT_READY"));
        assert!(require_comfy_runtime_ready(&status(true, true)).is_ok());
    }
}

fn emit_media_job_changed(app: &AppHandle, service: &MediaService, run: &MediaRun) {
    let workspace_id = service
        .get_node(&run.node_id)
        .ok()
        .flatten()
        .map(|node| node.workspace_id);
    let _ = app.emit(
        "media-job-changed",
        serde_json::json!({
            "type": "media-job-changed",
            "workspaceId": workspace_id,
            "runId": run.id.clone(),
            "nodeId": run.node_id.clone(),
            "status": run.status,
            "progress": run.progress,
            "assetIds": run.output_asset_ids.clone(),
            "errorCode": run.error_code.clone(),
            "errorMessage": run.error_message.clone(),
        }),
    );
}

#[tauri::command]
pub fn create_media_node(
    request: CreateMediaNodeRequest,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<MediaNode> {
    service.create_node(request)
}

#[tauri::command]
pub fn get_media_node(
    node_id: String,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<Option<MediaNode>> {
    service.get_node(&node_id)
}

#[tauri::command]
pub fn list_media_nodes(
    workspace_id: String,
    layout_id: Option<String>,
    include_deleted: Option<bool>,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<Vec<MediaNode>> {
    service.list_nodes(
        &workspace_id,
        layout_id.as_deref(),
        include_deleted.unwrap_or(false),
    )
}

#[tauri::command]
pub fn update_media_node(
    node_id: String,
    request: UpdateMediaNodeRequest,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<MediaNode> {
    service.update_node(&node_id, request)
}

#[tauri::command]
pub fn delete_media_node(
    node_id: String,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<bool> {
    service.delete_node(&node_id)
}

#[tauri::command]
pub fn create_media_run(
    request: CreateMediaRunRequest,
    app: AppHandle,
    service: State<'_, Arc<MediaService>>,
    providers: State<'_, Arc<ProviderService>>,
    runtime: State<'_, Arc<ComfyRuntimeService>>,
) -> AppResult<MediaRun> {
    let provider_config_fingerprint = provider_execution_config_fingerprint(
        &request.node_id,
        &request.request,
        &service,
        &providers,
        &runtime,
    )?;
    let run = service.create_run_with_provider_config_fingerprint(
        request,
        provider_config_fingerprint.as_deref(),
    )?;
    emit_media_job_changed(&app, &service, &run);
    Ok(run)
}

#[tauri::command]
pub fn get_media_run(
    run_id: String,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<Option<MediaRun>> {
    service.get_run(&run_id)
}

#[tauri::command]
pub fn list_media_runs(
    node_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<Vec<MediaRun>> {
    service.list_runs(&node_id, limit.unwrap_or(50), offset.unwrap_or(0))
}

#[tauri::command]
pub fn cancel_media_run(
    run_id: String,
    app: AppHandle,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<MediaRun> {
    let run = service.cancel_run(&run_id)?;
    emit_media_job_changed(&app, &service, &run);
    Ok(run)
}

#[tauri::command]
pub fn retry_media_run(
    run_id: String,
    app: AppHandle,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<MediaRun> {
    let run = service.retry_run(&run_id)?;
    emit_media_job_changed(&app, &service, &run);
    Ok(run)
}

#[tauri::command]
pub fn replay_media_run(
    run_id: String,
    request: ReplayMediaRunRequest,
    app: AppHandle,
    service: State<'_, Arc<MediaService>>,
    providers: State<'_, Arc<ProviderService>>,
    runtime: State<'_, Arc<ComfyRuntimeService>>,
) -> AppResult<MediaRun> {
    let provider_config_fingerprint =
        provider_execution_config_fingerprint_for_run(&run_id, &service, &providers, &runtime)?;
    let run = service.replay_run_with_provider_config_fingerprint(
        &run_id,
        request,
        provider_config_fingerprint.as_deref(),
    )?;
    emit_media_job_changed(&app, &service, &run);
    Ok(run)
}

#[tauri::command]
pub fn transition_media_run(
    run_id: String,
    status: MediaRunStatus,
    progress: Option<i32>,
    error_code: Option<String>,
    error_message: Option<String>,
    app: AppHandle,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<MediaRun> {
    let run = service.transition_run(&run_id, status, progress, error_code, error_message)?;
    emit_media_job_changed(&app, &service, &run);
    Ok(run)
}

#[tauri::command]
pub fn list_recoverable_media_runs(
    service: State<'_, Arc<MediaService>>,
) -> AppResult<Vec<MediaRun>> {
    service.recoverable_runs()
}

#[tauri::command]
pub fn get_media_queue_snapshot(
    service: State<'_, Arc<MediaService>>,
) -> AppResult<MediaQueueSnapshot> {
    service.queue_snapshot()
}

#[tauri::command]
pub fn get_media_scheduler_snapshot(
    worker: State<'_, Arc<MediaJobWorker>>,
) -> AppResult<MediaSchedulerSnapshot> {
    worker.scheduler_snapshot()
}

#[tauri::command]
pub fn set_media_run_priority(
    run_id: String,
    priority: i32,
    app: AppHandle,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<MediaRun> {
    let run = service.set_priority(&run_id, priority)?;
    emit_media_job_changed(&app, &service, &run);
    Ok(run)
}

#[tauri::command]
pub fn create_media_asset(
    request: CreateMediaAssetRequest,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<MediaAsset> {
    service.create_asset(request)
}

#[tauri::command]
pub fn stage_media_input(
    request: StageMediaInputRequest,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<MediaAsset> {
    service.stage_input(request)
}

#[tauri::command]
pub fn get_media_asset(
    asset_id: String,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<Option<MediaAsset>> {
    service.get_asset(&asset_id)
}

/// Resolve a validated generated asset to the Tauri asset protocol. The path
/// check lives in `MediaService`, so this command never accepts a raw file path.
#[tauri::command]
pub fn resolve_media_asset(
    asset_id: String,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<String> {
    let path = service.resolve_asset_path(&asset_id)?;
    // Own the lossy conversion before URL encoding; borrowing the temporary
    // `Cow` here would make the returned URL depend on a dropped path value.
    let path_text = path.to_string_lossy().into_owned();
    let encoded = encode(&path_text);
    if cfg!(windows) {
        Ok(format!("http://asset.localhost/{encoded}"))
    } else {
        Ok(format!("asset://localhost/{encoded}"))
    }
}

#[tauri::command]
pub fn list_media_assets(
    workspace_id: String,
    run_id: Option<String>,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<Vec<MediaAsset>> {
    service.list_assets(&workspace_id, run_id.as_deref())
}

#[tauri::command]
pub fn create_media_edge(
    request: CreateMediaEdgeRequest,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<MediaEdge> {
    service.create_edge(request)
}

#[tauri::command]
pub fn get_media_edge(
    edge_id: String,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<Option<MediaEdge>> {
    service.get_edge(&edge_id)
}

#[tauri::command]
pub fn list_media_edges(
    workspace_id: String,
    layout_id: Option<String>,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<Vec<MediaEdge>> {
    service.list_edges(&workspace_id, layout_id.as_deref())
}

#[tauri::command]
pub fn delete_media_edge(
    edge_id: String,
    service: State<'_, Arc<MediaService>>,
) -> AppResult<bool> {
    service.delete_edge(&edge_id)
}
