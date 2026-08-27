//! REST surface for media canvas persistence and job lifecycle.

use crate::state::AppState;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    Json,
};
use cc_panes_core::{
    models::{
        CreateMediaAssetRequest, CreateMediaEdgeRequest, CreateMediaNodeRequest,
        CreateMediaRunRequest, MediaAsset, MediaEdge, MediaNode, MediaQueueSnapshot, MediaRun,
        MediaRunStatus, ReplayMediaRunRequest, StageMediaInputRequest, UpdateMediaNodeRequest,
    },
    services::{
        apply_media_run_protocol, shared_comfy_adapter_cache, ComfyMediaAdapter,
        ComfyMemoryReleaseResult, ComfyObjectInfoResponse, ComfySystemStats, MediaProtocol,
        MediaProviderAdapter, MediaProviderCapabilities, MediaProviderProfile,
        OpenAiCompatibleMediaAdapter, COMFY_OBJECT_INFO_SCHEMA_VERSION,
    },
    utils::error::AppError,
};
use serde::Deserialize;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::io::ReaderStream;

type MediaHttpResult<T> = Result<Json<T>, (StatusCode, Json<AppError>)>;

fn emit_media_job_changed(state: &AppState, run: &MediaRun) {
    let workspace_id = state
        .media_service
        .get_node(&run.node_id)
        .ok()
        .flatten()
        .map(|node| node.workspace_id);
    state
        .ws_emitter
        .publish_media_job_changed(serde_json::json!({
            "type": "media-job-changed",
            "workspaceId": workspace_id,
            "runId": run.id.clone(),
            "nodeId": run.node_id.clone(),
            "status": run.status,
            "progress": run.progress,
            "assetIds": run.output_asset_ids.clone(),
            "errorCode": run.error_code.clone(),
            "errorMessage": run.error_message.clone(),
        }));
}

fn media_error(error: AppError) -> (StatusCode, Json<AppError>) {
    let status = match error.code() {
        Some("MEDIA_NODE_NOT_FOUND" | "MEDIA_RUN_NOT_FOUND" | "MEDIA_ASSET_NOT_FOUND") => {
            StatusCode::NOT_FOUND
        }
        Some(
            "MEDIA_IDEMPOTENCY_CONFLICT"
            | "MEDIA_RETRY_NOT_ALLOWED"
            | "MEDIA_INVALID_TRANSITION"
            | "MEDIA_EDGE_CYCLE"
            | "MEDIA_PRIORITY_NOT_ALLOWED"
            | "MEDIA_PRIORITY_CONFLICT",
        ) => StatusCode::CONFLICT,
        Some(code) if code.ends_with("_NOT_FOUND") => StatusCode::NOT_FOUND,
        _ => StatusCode::BAD_REQUEST,
    };
    (status, Json(error))
}

fn provider_execution_config_fingerprint(
    state: &AppState,
    node_id: &str,
    request: &serde_json::Value,
) -> Result<Option<String>, AppError> {
    let Some(node) = state.media_service.get_node(node_id)? else {
        return Ok(None);
    };
    let Some(provider_ref) = node.provider_ref.as_ref() else {
        return Ok(None);
    };
    let Some(provider) = state
        .provider_service
        .get_provider(&provider_ref.provider_id)
    else {
        // A manually registered adapter has no ProviderService snapshot.
        // Preserve its existing cache behavior instead of rejecting it.
        return Ok(None);
    };
    let profile = apply_media_run_protocol(
        MediaProviderProfile::from_provider(&provider)?,
        &node.parameters,
        request,
    )?;
    Ok(Some(profile.execution_config_fingerprint()?))
}

fn provider_execution_config_fingerprint_for_run(
    state: &AppState,
    run_id: &str,
) -> Result<Option<String>, AppError> {
    let Some(run) = state.media_service.get_run(run_id)? else {
        return Ok(None);
    };
    provider_execution_config_fingerprint(state, &run.node_id, &run.request)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaNodesQuery {
    pub workspace_id: String,
    pub layout_id: Option<String>,
    #[serde(default)]
    pub include_deleted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRunsQuery {
    pub node_id: String,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetsQuery {
    pub workspace_id: String,
    pub run_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEdgesQuery {
    pub workspace_id: String,
    pub layout_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyObjectInfoQuery {
    pub provider_id: String,
    pub class_type: Option<String>,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfySystemStatsQuery {
    pub provider_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyFreeMemoryRequest {
    pub provider_id: String,
    pub unload_models: bool,
    pub free_memory: bool,
}

fn comfy_adapter_for_provider(
    state: &AppState,
    provider_id: &str,
) -> Result<Arc<ComfyMediaAdapter>, AppError> {
    let provider = state
        .provider_service
        .get_provider(provider_id)
        .ok_or_else(|| {
            AppError::coded("COMFY_PROVIDER_NOT_FOUND", "ComfyUI provider was not found")
        })?;
    shared_comfy_adapter_cache().adapter_for_provider(&provider)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCapabilitiesQuery {
    pub provider_id: String,
    #[serde(default)]
    pub protocol: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionMediaRunRequest {
    pub status: MediaRunStatus,
    pub progress: Option<i32>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMediaPriorityRequest {
    pub priority: i32,
}

/// Fetch the live node capability schema from a user-selected ComfyUI
/// provider. The adapter enforces the HTTPS/loopback URL boundary before any
/// request leaves the daemon; credentials are not forwarded to this endpoint.
pub async fn get_comfy_object_info(
    State(state): State<AppState>,
    Query(query): Query<ComfyObjectInfoQuery>,
) -> MediaHttpResult<ComfyObjectInfoResponse> {
    let adapter = comfy_adapter_for_provider(&state, &query.provider_id).map_err(media_error)?;
    if query.refresh {
        adapter.clear_object_info_cache();
    }
    let (schema, schema_fingerprint) = adapter.object_info().await.map_err(media_error)?;
    let node = match query.class_type.as_deref() {
        Some(class_type) => adapter
            .object_info_for_node(class_type)
            .await
            .map_err(media_error)?,
        None => None,
    };
    Ok(Json(ComfyObjectInfoResponse {
        provider_id: query.provider_id,
        schema_fingerprint,
        schema_version: COMFY_OBJECT_INFO_SCHEMA_VERSION.to_string(),
        schema,
        node,
    }))
}

pub async fn get_comfy_system_stats(
    State(state): State<AppState>,
    Query(query): Query<ComfySystemStatsQuery>,
) -> MediaHttpResult<ComfySystemStats> {
    comfy_adapter_for_provider(&state, &query.provider_id)
        .map_err(media_error)?
        .system_stats()
        .await
        .map(Json)
        .map_err(media_error)
}

pub async fn free_comfy_memory(
    State(state): State<AppState>,
    Json(request): Json<ComfyFreeMemoryRequest>,
) -> MediaHttpResult<ComfyMemoryReleaseResult> {
    let adapter = comfy_adapter_for_provider(&state, &request.provider_id).map_err(media_error)?;
    adapter
        .free_memory(request.unload_models, request.free_memory)
        .await
        .map_err(media_error)?;
    Ok(Json(ComfyMemoryReleaseResult {
        provider_id: request.provider_id,
        unload_models: request.unload_models,
        free_memory: request.free_memory,
        accepted: true,
    }))
}

/// Return the normalized capability contract for the provider/protocol that
/// the media studio is about to use. The protocol is supplied by the studio
/// because the existing Provider record is shared with CLI launchers and does
/// not persist a media-specific protocol discriminator.
pub async fn get_provider_capabilities(
    State(state): State<AppState>,
    Query(query): Query<MediaCapabilitiesQuery>,
) -> MediaHttpResult<MediaProviderCapabilities> {
    let provider = state
        .provider_service
        .get_provider(&query.provider_id)
        .ok_or_else(|| {
            media_error(AppError::coded(
                "MEDIA_PROVIDER_NOT_FOUND",
                "media provider was not found",
            ))
        })?;
    let protocol = query
        .protocol
        .as_deref()
        .unwrap_or("open_ai_compatible")
        .parse::<MediaProtocol>()
        .map_err(|message| media_error(AppError::coded("MEDIA_PROTOCOL_INVALID", message)))?;
    let capabilities = match protocol {
        MediaProtocol::ComfyUi => shared_comfy_adapter_cache()
            .adapter_for_provider(&provider)
            .map_err(media_error)?
            .capabilities(),
        protocol => {
            let profile = MediaProviderProfile::from_provider(&provider)
                .map_err(media_error)?
                .with_protocol(protocol);
            OpenAiCompatibleMediaAdapter::new(profile)
                .map_err(media_error)?
                .capabilities()
        }
    };
    Ok(Json(capabilities))
}

pub async fn create_node(
    State(state): State<AppState>,
    Json(request): Json<CreateMediaNodeRequest>,
) -> MediaHttpResult<MediaNode> {
    state
        .media_service
        .create_node(request)
        .map(Json)
        .map_err(media_error)
}

pub async fn list_nodes(
    State(state): State<AppState>,
    Query(query): Query<MediaNodesQuery>,
) -> MediaHttpResult<Vec<MediaNode>> {
    state
        .media_service
        .list_nodes(
            &query.workspace_id,
            query.layout_id.as_deref(),
            query.include_deleted,
        )
        .map(Json)
        .map_err(media_error)
}

pub async fn get_node(
    State(state): State<AppState>,
    Path(node_id): Path<String>,
) -> MediaHttpResult<Option<MediaNode>> {
    state
        .media_service
        .get_node(&node_id)
        .map(Json)
        .map_err(media_error)
}

pub async fn update_node(
    State(state): State<AppState>,
    Path(node_id): Path<String>,
    Json(request): Json<UpdateMediaNodeRequest>,
) -> MediaHttpResult<MediaNode> {
    state
        .media_service
        .update_node(&node_id, request)
        .map(Json)
        .map_err(media_error)
}

pub async fn delete_node(
    State(state): State<AppState>,
    Path(node_id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<AppError>)> {
    state
        .media_service
        .delete_node(&node_id)
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(media_error)
}

pub async fn create_run(
    State(state): State<AppState>,
    Json(request): Json<CreateMediaRunRequest>,
) -> MediaHttpResult<MediaRun> {
    let provider_config_fingerprint =
        provider_execution_config_fingerprint(&state, &request.node_id, &request.request)
            .map_err(media_error)?;
    let run = state
        .media_service
        .create_run_with_provider_config_fingerprint(
            request,
            provider_config_fingerprint.as_deref(),
        )
        .map_err(media_error)?;
    emit_media_job_changed(&state, &run);
    Ok(Json(run))
}

pub async fn list_runs(
    State(state): State<AppState>,
    Query(query): Query<MediaRunsQuery>,
) -> MediaHttpResult<Vec<MediaRun>> {
    state
        .media_service
        .list_runs(
            &query.node_id,
            query.limit.unwrap_or(50),
            query.offset.unwrap_or(0),
        )
        .map(Json)
        .map_err(media_error)
}

pub async fn get_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> MediaHttpResult<Option<MediaRun>> {
    state
        .media_service
        .get_run(&run_id)
        .map(Json)
        .map_err(media_error)
}

pub async fn list_recoverable_runs(
    State(state): State<AppState>,
) -> MediaHttpResult<Vec<MediaRun>> {
    state
        .media_service
        .recoverable_runs()
        .map(Json)
        .map_err(media_error)
}

pub async fn get_queue_snapshot(
    State(state): State<AppState>,
) -> MediaHttpResult<MediaQueueSnapshot> {
    state
        .media_service
        .queue_snapshot()
        .map(Json)
        .map_err(media_error)
}

pub async fn cancel_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> MediaHttpResult<MediaRun> {
    let run = state
        .media_service
        .cancel_run(&run_id)
        .map_err(media_error)?;
    emit_media_job_changed(&state, &run);
    Ok(Json(run))
}

pub async fn retry_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> MediaHttpResult<MediaRun> {
    let run = state
        .media_service
        .retry_run(&run_id)
        .map_err(media_error)?;
    emit_media_job_changed(&state, &run);
    Ok(Json(run))
}

/// Copy a historical request into a fresh run. The service performs the
/// idempotency, input ownership, and parameter merge validation.
pub async fn replay_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Json(request): Json<ReplayMediaRunRequest>,
) -> MediaHttpResult<MediaRun> {
    let provider_config_fingerprint =
        provider_execution_config_fingerprint_for_run(&state, &run_id).map_err(media_error)?;
    let run = state
        .media_service
        .replay_run_with_provider_config_fingerprint(
            &run_id,
            request,
            provider_config_fingerprint.as_deref(),
        )
        .map_err(media_error)?;
    emit_media_job_changed(&state, &run);
    Ok(Json(run))
}

pub async fn set_priority(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Json(request): Json<SetMediaPriorityRequest>,
) -> MediaHttpResult<MediaRun> {
    let run = state
        .media_service
        .set_priority(&run_id, request.priority)
        .map_err(media_error)?;
    emit_media_job_changed(&state, &run);
    Ok(Json(run))
}

pub async fn transition_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Json(request): Json<TransitionMediaRunRequest>,
) -> MediaHttpResult<MediaRun> {
    let run = state
        .media_service
        .transition_run(
            &run_id,
            request.status,
            request.progress,
            request.error_code,
            request.error_message,
        )
        .map_err(media_error)?;
    emit_media_job_changed(&state, &run);
    Ok(Json(run))
}

pub async fn create_asset(
    State(state): State<AppState>,
    Json(request): Json<CreateMediaAssetRequest>,
) -> MediaHttpResult<MediaAsset> {
    state
        .media_service
        .create_asset(request)
        .map(Json)
        .map_err(media_error)
}

pub async fn stage_input(
    State(state): State<AppState>,
    Json(request): Json<StageMediaInputRequest>,
) -> MediaHttpResult<MediaAsset> {
    state
        .media_service
        .stage_input(request)
        .map(Json)
        .map_err(media_error)
}

pub async fn list_assets(
    State(state): State<AppState>,
    Query(query): Query<MediaAssetsQuery>,
) -> MediaHttpResult<Vec<MediaAsset>> {
    state
        .media_service
        .list_assets(&query.workspace_id, query.run_id.as_deref())
        .map(Json)
        .map_err(media_error)
}

pub async fn get_asset(
    State(state): State<AppState>,
    Path(asset_id): Path<String>,
) -> MediaHttpResult<Option<MediaAsset>> {
    state
        .media_service
        .get_asset(&asset_id)
        .map(Json)
        .map_err(media_error)
}

/// Serve a validated media asset for the Web Canvas. The first slice keeps
/// this endpoint deliberately narrow; `MediaService` performs the canonical
/// path and symlink check before any bytes are read.
pub async fn asset_content(
    State(state): State<AppState>,
    Path(asset_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<AppError>)> {
    let path = state
        .media_service
        .resolve_asset_path(&asset_id)
        .map_err(media_error)?;
    let metadata = tokio::fs::metadata(&path).await.map_err(|error| {
        media_error(AppError::coded("MEDIA_ASSET_NOT_FOUND", error.to_string()))
    })?;
    let total_size = metadata.len();
    let selected = match parse_range(headers.get(header::RANGE), total_size) {
        Ok(selected) => selected,
        Err(()) => {
            return Err((
                StatusCode::RANGE_NOT_SATISFIABLE,
                Json(AppError::coded(
                    "MEDIA_RANGE_INVALID",
                    "requested byte range is not satisfiable",
                )),
            ));
        }
    };
    let (start, end, status) =
        selected.unwrap_or_else(|| (0, total_size.saturating_sub(1), StatusCode::OK));
    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let mut file = tokio::fs::File::open(&path).await.map_err(|error| {
        media_error(AppError::coded("MEDIA_ASSET_NOT_FOUND", error.to_string()))
    })?;
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await.map_err(|error| {
            media_error(AppError::coded("MEDIA_ASSET_NOT_FOUND", error.to_string()))
        })?;
    }
    let length = if total_size == 0 || end < start {
        0
    } else {
        end - start + 1
    };
    let stream = ReaderStream::with_capacity(file.take(length), 64 * 1024);
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        );
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total_size}"),
        );
    }
    builder
        .body(Body::from_stream(stream))
        .map_err(|error| media_error(AppError::from(error.to_string())))
}

/// Parse one RFC 9110 byte range. Multiple ranges are deliberately rejected;
/// browser media elements only need a single contiguous segment and rejecting
/// multipart responses keeps the endpoint easy to audit.
fn parse_range(
    value: Option<&HeaderValue>,
    total_size: u64,
) -> Result<Option<(u64, u64, StatusCode)>, ()> {
    let Some(value) = value else { return Ok(None) };
    let text = value.to_str().map_err(|_| ())?;
    let Some(spec) = text.strip_prefix("bytes=") else {
        return Err(());
    };
    if spec.contains(',') || total_size == 0 {
        return Err(());
    }
    let (start_text, end_text) = spec.split_once('-').ok_or(())?;
    let (start, end) = if start_text.is_empty() {
        let suffix = end_text.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let length = suffix.min(total_size);
        (total_size - length, total_size - 1)
    } else {
        let start = start_text.parse::<u64>().map_err(|_| ())?;
        if start >= total_size {
            return Err(());
        }
        let end = if end_text.is_empty() {
            total_size - 1
        } else {
            end_text.parse::<u64>().map_err(|_| ())?.min(total_size - 1)
        };
        if end < start {
            return Err(());
        }
        (start, end)
    };
    Ok(Some((start, end, StatusCode::PARTIAL_CONTENT)))
}

pub async fn create_edge(
    State(state): State<AppState>,
    Json(request): Json<CreateMediaEdgeRequest>,
) -> MediaHttpResult<MediaEdge> {
    state
        .media_service
        .create_edge(request)
        .map(Json)
        .map_err(media_error)
}

pub async fn list_edges(
    State(state): State<AppState>,
    Query(query): Query<MediaEdgesQuery>,
) -> MediaHttpResult<Vec<MediaEdge>> {
    state
        .media_service
        .list_edges(&query.workspace_id, query.layout_id.as_deref())
        .map(Json)
        .map_err(media_error)
}

pub async fn get_edge(
    State(state): State<AppState>,
    Path(edge_id): Path<String>,
) -> MediaHttpResult<Option<MediaEdge>> {
    state
        .media_service
        .get_edge(&edge_id)
        .map(Json)
        .map_err(media_error)
}

pub async fn delete_edge(
    State(state): State<AppState>,
    Path(edge_id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<AppError>)> {
    state
        .media_service
        .delete_edge(&edge_id)
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(media_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(value: &'static str, size: u64) -> (u64, u64) {
        let parsed = parse_range(Some(&HeaderValue::from_static(value)), size)
            .expect("valid range")
            .expect("range present");
        (parsed.0, parsed.1)
    }

    #[test]
    fn parses_open_ended_and_suffix_ranges() {
        assert_eq!(range("bytes=10-", 100), (10, 99));
        assert_eq!(range("bytes=-8", 100), (92, 99));
        assert_eq!(range("bytes=10-20", 100), (10, 20));
    }

    #[test]
    fn clamps_end_and_rejects_invalid_ranges() {
        assert_eq!(range("bytes=90-999", 100), (90, 99));
        assert!(parse_range(Some(&HeaderValue::from_static("bytes=100-")), 100).is_err());
        assert!(parse_range(Some(&HeaderValue::from_static("bytes=1-2,4-5")), 100).is_err());
        assert!(parse_range(Some(&HeaderValue::from_static("bytes=-0")), 100).is_err());
    }
}

#[cfg(test)]
#[path = "media_tests.rs"]
mod media_tests;
