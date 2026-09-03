//! Durable media job worker built on the provider adapter contract.
//!
//! The worker is deliberately cooperative: applications own its lifetime and
//! call `run_once` from their background loop. All durable state transitions
//! still pass through `MediaService`, so Tauri, Web, and MCP share one state
//! machine and lease protocol.

use super::comfy::ComfyEvent;
use super::comfy_adapter::{ComfyAdapterProfile, ComfyMediaAdapter};
use super::media_provider::{
    apply_media_run_protocol, DownloadedAsset, MediaInputAsset, MediaProtocol,
    MediaProviderAdapter, MediaProviderProfile, MediaProviderRegistry, NormalizedMediaRequest,
    OpenAiCompatibleMediaAdapter, RemoteJob, RemoteJobStatus, RemoteOutput, Sub2ApiMediaAdapter,
};
use crate::models::{
    MediaKind, MediaProviderOutput, MediaResourceSnapshot, MediaRun, MediaRunStatus,
    MediaSchedulerSnapshot,
};
use crate::services::{MediaService, ProviderService};
use crate::utils::error::{AppError, AppResult};
use base64::Engine;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use sysinfo::System;

/// One bounded worker instance. Multiple processes can share the same DB;
/// `MediaService::claim_next_run` prevents duplicate submissions.
#[derive(Clone)]
pub struct MediaJobWorker {
    service: Arc<MediaService>,
    registry: MediaProviderRegistry,
    provider_service: Option<Arc<ProviderService>>,
    owner: String,
    lease_duration: chrono::Duration,
    comfy_adapters: Arc<RwLock<HashMap<String, Arc<ComfyMediaAdapter>>>>,
    max_concurrent: usize,
    active_jobs: Arc<AtomicUsize>,
    min_free_memory_bytes: Option<u64>,
}

impl MediaJobWorker {
    pub fn new(
        service: Arc<MediaService>,
        registry: MediaProviderRegistry,
        owner: impl Into<String>,
    ) -> Self {
        Self {
            service,
            registry,
            provider_service: None,
            owner: owner.into(),
            lease_duration: chrono::Duration::seconds(90),
            comfy_adapters: Arc::new(RwLock::new(HashMap::new())),
            max_concurrent: 1,
            active_jobs: Arc::new(AtomicUsize::new(0)),
            min_free_memory_bytes: None,
        }
    }

    pub fn with_lease_duration(mut self, lease_duration: chrono::Duration) -> Self {
        self.lease_duration = lease_duration.max(chrono::Duration::seconds(1));
        self
    }

    pub fn with_provider_service(mut self, provider_service: Arc<ProviderService>) -> Self {
        self.provider_service = Some(provider_service);
        self
    }

    pub fn with_max_concurrent(mut self, max_concurrent: usize) -> Self {
        self.max_concurrent = max_concurrent.clamp(1, 32);
        self
    }

    pub fn with_min_free_memory(mut self, bytes: Option<u64>) -> Self {
        self.min_free_memory_bytes = bytes;
        self
    }

    pub fn scheduler_snapshot(&self) -> AppResult<MediaSchedulerSnapshot> {
        Ok(MediaSchedulerSnapshot {
            queue: self.service.queue_snapshot()?,
            active_workers: self.active_jobs.load(Ordering::Acquire),
            max_concurrent: self.max_concurrent,
            owner: self.owner.clone(),
            resource: sample_resources(),
        })
    }

    /// Concrete ComfyUI adapters currently used by this worker. Applications
    /// use this snapshot to maintain websocket subscriptions for remote
    /// providers; the registry still owns the provider-neutral adapter trait.
    pub fn comfy_adapters(&self) -> Vec<(String, Arc<ComfyMediaAdapter>)> {
        self.comfy_adapters
            .read()
            .iter()
            .map(|(id, adapter)| (id.clone(), adapter.clone()))
            .collect()
    }

    pub fn track_comfy_adapter(
        &self,
        provider_id: impl Into<String>,
        adapter: Arc<ComfyMediaAdapter>,
    ) {
        self.comfy_adapters
            .write()
            .insert(provider_id.into(), adapter);
    }

    pub fn forget_comfy_adapter(&self, provider_id: &str) {
        self.comfy_adapters.write().remove(provider_id);
    }

    pub async fn run_once(&self) -> AppResult<Option<MediaRun>> {
        if !self.resource_gate_allows_start() || !self.try_reserve_slot() {
            return Ok(None);
        }
        let run = match self
            .service
            .claim_next_run(&self.owner, self.lease_duration)
        {
            Ok(Some(run)) => run,
            Ok(None) => {
                self.release_slot();
                return Ok(None);
            }
            Err(error) => {
                self.release_slot();
                return Err(error);
            }
        };
        Some(self.process_reserved(run).await).transpose()
    }

    /// Claim and process up to the configured concurrency in parallel. The
    /// legacy `run_once` API remains useful for deterministic callers/tests.
    pub async fn run_batch(&self) -> AppResult<Vec<MediaRun>> {
        if !self.resource_gate_allows_start() {
            return Ok(Vec::new());
        }
        let mut claimed = Vec::new();
        let mut claimed_ids = Vec::new();
        let mut claim_error = None;
        for _ in 0..self.max_concurrent {
            if !self.try_reserve_slot() {
                break;
            }
            match self.service.claim_next_run_excluding(
                &self.owner,
                self.lease_duration,
                &claimed_ids,
            ) {
                Ok(Some(run)) => {
                    claimed_ids.push(run.id.clone());
                    claimed.push(run);
                }
                Ok(None) => self.release_slot(),
                Err(error) => {
                    self.release_slot();
                    claim_error = Some(error);
                    break;
                }
            }
        }
        let futures = claimed
            .into_iter()
            .map(|run| async move { self.process_reserved(run).await });
        let results = futures_util::future::join_all(futures).await;
        let mut processed = Vec::new();
        let mut first_error = None;
        for result in results {
            match result {
                Ok(run) => processed.push(run),
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        if let Some(error) = claim_error {
            return Err(error);
        }
        Ok(processed)
    }

    pub async fn run_until_idle(&self, max_iterations: usize) -> AppResult<Vec<MediaRun>> {
        let mut processed = Vec::new();
        for _ in 0..max_iterations {
            let Some(run) = self.run_once().await? else {
                break;
            };
            processed.push(run);
        }
        Ok(processed)
    }

    async fn process_reserved(&self, run: MediaRun) -> AppResult<MediaRun> {
        let result = self.process_claimed(run).await;
        self.release_slot();
        result
    }

    fn try_reserve_slot(&self) -> bool {
        let mut current = self.active_jobs.load(Ordering::Acquire);
        loop {
            if current >= self.max_concurrent {
                return false;
            }
            match self.active_jobs.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(next) => current = next,
            }
        }
    }

    fn release_slot(&self) {
        self.active_jobs.fetch_sub(1, Ordering::AcqRel);
    }

    fn resource_gate_allows_start(&self) -> bool {
        self.min_free_memory_bytes
            .is_none_or(|minimum| sample_resources().free_memory_bytes >= minimum)
    }

    /// Route one ComfyUI websocket event to the durable run identified by its
    /// prompt id. Unknown/non-job events are ignored, while error and
    /// interruption messages are recorded as diagnostics without bypassing
    /// the history poll that downloads authoritative outputs.
    pub fn apply_comfy_event(
        &self,
        provider_id: &str,
        event: &ComfyEvent,
    ) -> AppResult<Option<MediaRun>> {
        let prompt_id = event.prompt_id();
        if prompt_id.is_empty() {
            return Ok(None);
        }
        let (progress, error_code, error_message) = match event {
            ComfyEvent::ExecutionError { message, .. } => (
                event.progress_percent(),
                Some("COMFY_EXECUTION_ERROR"),
                message.as_deref(),
            ),
            ComfyEvent::ExecutionInterrupted { .. } => (
                event.progress_percent(),
                Some("COMFY_EXECUTION_INTERRUPTED"),
                Some("ComfyUI execution was interrupted"),
            ),
            ComfyEvent::ExecutionSuccess { .. } => (Some(100), None, None),
            _ => (event.progress_percent(), None, None),
        };
        self.service.apply_provider_event(
            provider_id,
            prompt_id,
            progress,
            error_code,
            error_message,
        )
    }

    async fn process_claimed(&self, run: MediaRun) -> AppResult<MediaRun> {
        let node = self
            .service
            .get_node(&run.node_id)?
            .ok_or_else(|| AppError::coded("MEDIA_NODE_NOT_FOUND", "media node not found"))?;
        let Some(provider_id) = run
            .provider_ref
            .as_ref()
            .map(|provider| provider.provider_id.as_str())
        else {
            return self.fail(
                &run.id,
                "MEDIA_PROVIDER_REQUIRED",
                "media node has no provider",
            );
        };
        // Provider settings can be edited while the worker is alive. Refresh
        // the adapter from the current secret-bearing service snapshot before
        // each job so URL and API key changes take effect immediately.
        if let Some(provider_service) = &self.provider_service {
            if let Some(provider) = provider_service.get_provider(provider_id) {
                let profile =
                    match MediaProviderProfile::from_provider(&provider).and_then(|profile| {
                        apply_media_run_protocol(profile, &node.parameters, &run.request)
                    }) {
                        Ok(profile) => profile,
                        Err(error) => {
                            return self.fail(
                                &run.id,
                                error.code().unwrap_or("MEDIA_PROVIDER_INVALID"),
                                error.message(),
                            )
                        }
                    };
                let adapter_result: AppResult<Arc<dyn MediaProviderAdapter>> =
                    match profile.protocol {
                        MediaProtocol::ComfyUi => {
                            ComfyAdapterProfile::new(provider_id, profile.base_url.clone())
                                .and_then(ComfyMediaAdapter::new)
                                .map(|adapter| {
                                    let adapter = Arc::new(adapter);
                                    self.comfy_adapters
                                        .write()
                                        .insert(provider_id.to_string(), adapter.clone());
                                    adapter as Arc<dyn MediaProviderAdapter>
                                })
                        }
                        MediaProtocol::Sub2Api => Sub2ApiMediaAdapter::new(profile)
                            .map(|adapter| Arc::new(adapter) as Arc<dyn MediaProviderAdapter>),
                        _ => OpenAiCompatibleMediaAdapter::new(profile)
                            .map(|adapter| Arc::new(adapter) as Arc<dyn MediaProviderAdapter>),
                    };
                let adapter = match adapter_result {
                    Ok(adapter) => adapter,
                    Err(error) => {
                        return self.fail(
                            &run.id,
                            error.code().unwrap_or("MEDIA_PROVIDER_INVALID"),
                            error.message(),
                        )
                    }
                };
                self.registry.upsert(adapter)?;
            }
        }
        let adapter = match self.registry.require(provider_id) {
            Ok(adapter) => adapter,
            Err(error) => {
                return self.fail(
                    &run.id,
                    error.code().unwrap_or("MEDIA_PROVIDER_NOT_FOUND"),
                    error.message(),
                )
            }
        };
        let request = match self.normalized_request(&run, &node) {
            Ok(request) => request,
            Err(error) => {
                return self.fail(
                    &run.id,
                    error.code().unwrap_or("MEDIA_REQUEST_INVALID"),
                    error.message(),
                )
            }
        };

        if run.status == MediaRunStatus::Canceling {
            return self.cancel_claimed(run, adapter, request).await;
        }

        let remote = if let Some(remote_job_id) = run.remote_job_id.clone() {
            RemoteJob {
                id: remote_job_id,
                status: MediaRunStatus::Processing,
                status_url: None,
                cancel_url: None,
                progress: run.progress,
                outputs: Vec::new(),
                error: None,
            }
        } else {
            self.service
                .renew_run_lease(&run.id, &self.owner, self.lease_duration)?;
            let submitted = match adapter.submit(request.clone()).await {
                Ok(submitted) => submitted,
                Err(error) => {
                    return self.fail(
                        &run.id,
                        error.code().unwrap_or("MEDIA_PROVIDER_SUBMIT"),
                        error.message(),
                    )
                }
            };
            self.service.record_remote_job(
                &run.id,
                &self.owner,
                &submitted.id,
                MediaRunStatus::Processing,
                submitted.progress.or(Some(0)),
            )?;
            submitted
        };

        if remote.status == MediaRunStatus::Succeeded && !remote.outputs.is_empty() {
            let status = RemoteJobStatus {
                id: remote.id.clone(),
                status: remote.status,
                status_url: remote.status_url.clone(),
                cancel_url: remote.cancel_url.clone(),
                progress: remote.progress,
                outputs: remote.outputs.clone(),
                error: remote.error.clone(),
            };
            return self.finish_success(&status, run.id).await;
        }
        if remote.status == MediaRunStatus::Failed {
            return self.fail(
                &run.id,
                remote
                    .error
                    .as_ref()
                    .and_then(|error| error.code.as_deref())
                    .unwrap_or("MEDIA_PROVIDER_FAILED"),
                remote
                    .error
                    .as_ref()
                    .map(|error| error.message.as_str())
                    .unwrap_or("provider rejected the media job"),
            );
        }

        let current = self
            .service
            .get_run(&run.id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run disappeared"))?;
        if current.status == MediaRunStatus::Canceling {
            return self.cancel_claimed(current, adapter, request).await;
        }

        self.service
            .renew_run_lease(&run.id, &self.owner, self.lease_duration)?;
        let status = match adapter.poll_for_kind(&remote, node.kind).await {
            Ok(status) => status,
            Err(error) => {
                return self.fail(
                    &run.id,
                    error.code().unwrap_or("MEDIA_PROVIDER_POLL"),
                    error.message(),
                )
            }
        };
        match status.status {
            MediaRunStatus::Succeeded => self.finish_success(&status, run.id).await,
            MediaRunStatus::Failed => self.fail(
                &run.id,
                status
                    .error
                    .as_ref()
                    .and_then(|error| error.code.as_deref())
                    .unwrap_or("MEDIA_PROVIDER_FAILED"),
                status
                    .error
                    .as_ref()
                    .map(|error| error.message.as_str())
                    .unwrap_or("provider reported a failed media job"),
            ),
            MediaRunStatus::Canceled => {
                let canceled = self.service.transition_run_for_owner(
                    &run.id,
                    &self.owner,
                    MediaRunStatus::Canceled,
                    status.progress,
                    None,
                    None,
                )?;
                self.clear_lease(canceled)
            }
            _ => {
                let processing = self.service.transition_run_for_owner(
                    &run.id,
                    &self.owner,
                    MediaRunStatus::Processing,
                    status.progress,
                    None,
                    None,
                )?;
                self.service
                    .renew_run_lease(&processing.id, &self.owner, self.lease_duration)
            }
        }
    }

    fn normalized_request(
        &self,
        run: &MediaRun,
        node: &crate::models::MediaNode,
    ) -> AppResult<NormalizedMediaRequest> {
        let object = run.request.as_object().cloned().unwrap_or_default();
        let prompt = object
            .get("prompt")
            .or_else(|| object.get("text"))
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let mut parameters = node.parameters.as_object().cloned().unwrap_or_default();
        if let Some(request_parameters) =
            object.get("parameters").and_then(|value| value.as_object())
        {
            parameters.extend(request_parameters.clone());
        } else {
            // Older runs stored generation fields beside `prompt`. Preserve
            // those fields when replaying instead of sending the envelope as
            // provider parameters.
            parameters.extend(
                object
                    .iter()
                    .filter(|(key, _)| !Self::is_request_envelope_key(key))
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
        // Provider selection is a CC-Panes routing hint, never a wire-level
        // generation parameter for OpenAI-compatible adapters.
        for key in [
            "providerProtocol",
            "provider_protocol",
            // Workspace/project scope is an internal routing and storage
            // contract. In particular, never send a local project path to a
            // cloud provider or persist it in a provider workflow.
            "mediaScope",
            "media_scope",
            "mediaStorage",
            "media_storage",
            "workspaceId",
            "workspace_id",
            "projectId",
            "project_id",
            "projectPath",
            "project_path",
        ] {
            parameters.remove(key);
        }
        let parameters = serde_json::Value::Object(parameters);
        let model = run
            .provider_ref
            .as_ref()
            .map(|provider| provider.model_id.clone())
            .or_else(|| {
                node.provider_ref
                    .as_ref()
                    .map(|provider| provider.model_id.clone())
            })
            .ok_or_else(|| AppError::coded("MEDIA_MODEL_REQUIRED", "media model is required"))?;
        let input_assets = run
            .input_asset_ids
            .iter()
            .map(|asset_id| {
                let asset = self.service.get_asset(asset_id)?.ok_or_else(|| {
                    AppError::coded("MEDIA_ASSET_NOT_FOUND", "media input asset not found")
                })?;
                if asset.workspace_id != node.workspace_id {
                    return Err(AppError::coded(
                        "MEDIA_WORKSPACE_MISMATCH",
                        "media input asset belongs to another workspace",
                    ));
                }
                let path = self.service.resolve_asset_path(asset_id)?;
                let bytes = std::fs::read(path)?;
                if bytes.len() > 64 * 1024 * 1024 {
                    return Err(AppError::coded(
                        "MEDIA_INPUT_TOO_LARGE",
                        "media input exceeds 64MB",
                    ));
                }
                Ok(MediaInputAsset {
                    url: None,
                    data: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
                    mime_type: Some(asset.mime_type),
                    metadata: provider_safe_asset_metadata(asset.metadata),
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        let normalized = NormalizedMediaRequest {
            operation: run.operation,
            kind: node.kind,
            model,
            prompt,
            input_assets,
            parameters,
            client_request_id: run.client_request_id.clone(),
        };
        normalized.validate()?;
        Ok(normalized)
    }

    fn is_request_envelope_key(key: &str) -> bool {
        matches!(
            key,
            "prompt"
                | "text"
                | "parameters"
                | "replayOfRunId"
                | "replay_of_run_id"
                | "providerProtocol"
                | "provider_protocol"
                | "mediaScope"
                | "media_scope"
                | "mediaStorage"
                | "media_storage"
                | "workspaceId"
                | "workspace_id"
                | "projectId"
                | "project_id"
                | "projectPath"
                | "project_path"
                | "clientRequestId"
                | "client_request_id"
        )
    }

    async fn cancel_claimed(
        &self,
        run: MediaRun,
        adapter: Arc<dyn MediaProviderAdapter>,
        request: NormalizedMediaRequest,
    ) -> AppResult<MediaRun> {
        if let Some(remote_job_id) = run.remote_job_id.clone() {
            let remote = RemoteJob {
                id: remote_job_id,
                status: MediaRunStatus::Processing,
                status_url: None,
                cancel_url: None,
                progress: run.progress,
                outputs: Vec::new(),
                error: None,
            };
            if let Err(error) = adapter.cancel(&remote).await {
                return self.fail(
                    &run.id,
                    error.code().unwrap_or("MEDIA_PROVIDER_CANCEL"),
                    error.message(),
                );
            }
        }
        let canceled = self.service.transition_run_for_owner(
            &run.id,
            &self.owner,
            MediaRunStatus::Canceled,
            run.progress,
            None,
            None,
        )?;
        let _ = request;
        self.clear_lease(canceled)
    }

    async fn finish_success(
        &self,
        status: &RemoteJobStatus,
        run_id: String,
    ) -> AppResult<MediaRun> {
        if status.outputs.is_empty() {
            return self.fail(
                &run_id,
                "MEDIA_PROVIDER_EMPTY_OUTPUT",
                "provider returned no media outputs",
            );
        }
        let downloading = self.service.transition_run_for_owner(
            &run_id,
            &self.owner,
            MediaRunStatus::Downloading,
            Some(95),
            None,
            None,
        )?;
        let expected_kind = self
            .service
            .get_run(&run_id)?
            .and_then(|run| self.service.get_node(&run.node_id).ok().flatten())
            .map(|node| node.kind)
            .ok_or_else(|| AppError::coded("MEDIA_NODE_NOT_FOUND", "media node not found"))?;
        let Some(provider_id) = downloading
            .provider_ref
            .as_ref()
            .map(|provider| provider.provider_id.as_str())
        else {
            return self.fail(&run_id, "MEDIA_PROVIDER_REQUIRED", "media provider missing");
        };
        let adapter = match self.registry.require(provider_id) {
            Ok(adapter) => adapter,
            Err(error) => {
                return self.fail(
                    &run_id,
                    error.code().unwrap_or("MEDIA_PROVIDER_NOT_FOUND"),
                    error.message(),
                )
            }
        };
        for output in &status.outputs {
            self.service
                .renew_run_lease(&run_id, &self.owner, self.lease_duration)?;
            let downloaded = match adapter.download(output).await {
                Ok(downloaded) => downloaded,
                Err(error) => {
                    return self.fail(
                        &run_id,
                        error.code().unwrap_or("MEDIA_PROVIDER_DOWNLOAD"),
                        error.message(),
                    )
                }
            };
            self.service.persist_provider_output_for_owner(
                &run_id,
                &self.owner,
                &to_provider_output(downloaded, output, expected_kind),
            )?;
        }
        let succeeded = self.service.transition_run_for_owner(
            &run_id,
            &self.owner,
            MediaRunStatus::Succeeded,
            Some(100),
            None,
            None,
        )?;
        if let Err(error) = self.service.register_cache(&succeeded) {
            tracing::warn!(run_id = %run_id, error = %error, "media cache registration failed");
        }
        self.clear_lease(succeeded)
    }

    fn fail(&self, run_id: &str, code: &str, message: &str) -> AppResult<MediaRun> {
        let run = self
            .service
            .get_run(run_id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found"))?;
        let failed = self.service.transition_run_for_owner(
            run_id,
            &self.owner,
            MediaRunStatus::Failed,
            run.progress,
            Some(code.to_string()),
            Some(message.to_string()),
        )?;
        self.clear_lease(failed)
    }

    fn clear_lease(&self, run: MediaRun) -> AppResult<MediaRun> {
        self.service.clear_run_lease(&run.id, &self.owner)?;
        self.service
            .get_run(&run.id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run disappeared"))
    }
}

fn to_provider_output(
    downloaded: DownloadedAsset,
    source: &RemoteOutput,
    expected_kind: MediaKind,
) -> MediaProviderOutput {
    let extension = downloaded
        .filename
        .as_deref()
        .and_then(|name| name.rsplit('.').next())
        .map(str::to_ascii_lowercase);
    let mut metadata = merge_metadata(downloaded.metadata, source.metadata.clone());
    if expected_kind == MediaKind::Video
        && source.kind == Some(MediaKind::Image)
        && downloaded.mime_type.starts_with("image/")
        && metadata.get("role").is_none()
    {
        metadata["role"] = serde_json::Value::String("poster".to_string());
    }
    MediaProviderOutput {
        bytes: downloaded.bytes,
        mime_type: downloaded.mime_type,
        extension,
        sha256: Some(downloaded.sha256),
        width: None,
        height: None,
        duration_ms: None,
        metadata,
    }
}

fn merge_metadata(left: serde_json::Value, right: serde_json::Value) -> serde_json::Value {
    let mut result = match left {
        serde_json::Value::Object(object) => object,
        _ => serde_json::Map::new(),
    };
    if let serde_json::Value::Object(object) = right {
        result.extend(object);
    }
    serde_json::Value::Object(result)
}

fn sample_resources() -> MediaResourceSnapshot {
    let mut system = System::new();
    system.refresh_cpu_usage();
    system.refresh_memory();
    let total = system.total_memory();
    let used = system.used_memory();
    MediaResourceSnapshot {
        cpu_percent: system.global_cpu_usage(),
        memory_used_bytes: used,
        memory_total_bytes: total,
        free_memory_bytes: total.saturating_sub(used),
        gpu_free_bytes: None,
        gpu_total_bytes: None,
        sampled_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// Small deterministic adapter for tests and local UI smoke runs.
pub struct DeterministicMockMediaProvider {
    id: String,
    bytes: Vec<u8>,
    mime_type: String,
}

impl DeterministicMockMediaProvider {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            bytes: vec![
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
                0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
                0x00, 0x1f, 0x15, 0xc4, 0x89,
            ],
            mime_type: "image/png".to_string(),
        }
    }
}

impl MediaProviderAdapter for DeterministicMockMediaProvider {
    fn provider_id(&self) -> &str {
        &self.id
    }

    fn protocol(&self) -> super::media_provider::MediaProtocol {
        super::media_provider::MediaProtocol::Custom("mock".to_string())
    }

    fn capabilities(&self) -> super::media_provider::MediaProviderCapabilities {
        super::media_provider::MediaProviderCapabilities {
            provider_id: self.id.clone(),
            protocol: self.protocol(),
            kinds: vec![MediaKind::Image],
            operations: vec![crate::models::MediaOperation::TextToImage],
            supports_async_jobs: true,
            supports_cancel: false,
        }
    }

    fn submit<'a>(
        &'a self,
        _request: NormalizedMediaRequest,
    ) -> super::media_provider::MediaProviderFuture<'a, RemoteJob> {
        Box::pin(async {
            Ok(RemoteJob {
                id: "mock-job".to_string(),
                status: MediaRunStatus::Processing,
                status_url: None,
                cancel_url: None,
                progress: Some(10),
                outputs: Vec::new(),
                error: None,
            })
        })
    }

    fn poll<'a>(
        &'a self,
        _job: &'a RemoteJob,
    ) -> super::media_provider::MediaProviderFuture<'a, RemoteJobStatus> {
        Box::pin(async {
            Ok(RemoteJobStatus {
                id: "mock-job".to_string(),
                status: MediaRunStatus::Succeeded,
                status_url: None,
                cancel_url: None,
                progress: Some(100),
                outputs: vec![RemoteOutput {
                    url: None,
                    b64_json: Some(base64::engine::general_purpose::STANDARD.encode(&self.bytes)),
                    mime_type: Some(self.mime_type.clone()),
                    filename: Some("mock.png".to_string()),
                    kind: Some(MediaKind::Image),
                    metadata: serde_json::json!({"mock": true}),
                }],
                error: None,
            })
        })
    }

    fn cancel<'a>(
        &'a self,
        _job: &'a RemoteJob,
    ) -> super::media_provider::MediaProviderFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn download<'a>(
        &'a self,
        output: &'a RemoteOutput,
    ) -> super::media_provider::MediaProviderFuture<'a, DownloadedAsset> {
        Box::pin(async move {
            let bytes = output
                .b64_json
                .as_deref()
                .ok_or_else(|| AppError::coded("MEDIA_OUTPUT_INVALID", "mock output missing data"))
                .and_then(|value| {
                    base64::engine::general_purpose::STANDARD
                        .decode(value)
                        .map_err(|_| AppError::coded("MEDIA_OUTPUT_INVALID", "mock output invalid"))
                })?;
            let mut hasher = sha2::Sha256::new();
            use sha2::Digest;
            hasher.update(&bytes);
            Ok(DownloadedAsset {
                size_bytes: bytes.len() as u64,
                bytes,
                mime_type: self.mime_type.clone(),
                sha256: format!("{:x}", hasher.finalize()),
                filename: Some("mock.png".to_string()),
                source_url: None,
                metadata: serde_json::json!({"mock": true}),
            })
        })
    }
}

fn provider_safe_asset_metadata(mut metadata: serde_json::Value) -> serde_json::Value {
    if let Some(object) = metadata.as_object_mut() {
        for key in [
            "mediaScope",
            "media_scope",
            "mediaStorage",
            "media_storage",
            "workspaceId",
            "workspace_id",
            "projectId",
            "project_id",
            "projectPath",
            "project_path",
        ] {
            object.remove(key);
        }
    }
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        CreateMediaNodeRequest, CreateMediaRunRequest, MediaOperation, MediaProviderRef,
    };
    use crate::repository::{Database, MediaRepository};
    use tempfile::tempdir;

    #[tokio::test]
    async fn mock_worker_submits_polls_downloads_and_releases_lease() {
        let root = tempdir().expect("temp root");
        let service = Arc::new(MediaService::with_media_root(
            Arc::new(MediaRepository::new(Arc::new(
                Database::new_in_memory().unwrap(),
            ))),
            root.path().to_path_buf(),
        ));
        let node = service
            .create_node(CreateMediaNodeRequest {
                workspace_id: "ws".into(),
                layout_id: "layout".into(),
                kind: MediaKind::Image,
                title: "Mock".into(),
                default_operation: Some(MediaOperation::TextToImage),
                provider_ref: Some(MediaProviderRef {
                    provider_id: "mock".into(),
                    model_id: "image-model".into(),
                }),
                parameters: None,
            })
            .unwrap();
        let created = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({"prompt": "a test"}),
                client_request_id: Some("mock-request".into()),
                input_asset_ids: Vec::new(),
                priority: None,
                cache_policy: None,
            })
            .unwrap();
        let registry = MediaProviderRegistry::new();
        registry
            .register(Arc::new(DeterministicMockMediaProvider::new("mock")))
            .unwrap();
        let worker = MediaJobWorker::new(Arc::clone(&service), registry, "worker-test");
        let processed = worker.run_once().await.unwrap().expect("processed run");
        assert_eq!(processed.id, created.id);
        assert_eq!(processed.status, MediaRunStatus::Succeeded);
        assert!(processed.lease_owner.is_none());
        assert_eq!(
            service.list_assets("ws", Some(&created.id)).unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn worker_releases_reserved_slot_when_claim_fails() {
        let service = Arc::new(MediaService::with_media_root(
            Arc::new(MediaRepository::new(Arc::new(
                Database::new_in_memory().unwrap(),
            ))),
            tempfile::tempdir().unwrap().path().to_path_buf(),
        ));
        let worker = MediaJobWorker::new(service, MediaProviderRegistry::new(), "");

        assert_eq!(
            worker.run_batch().await.unwrap_err().code(),
            Some("MEDIA_LEASE_OWNER_INVALID")
        );
        assert_eq!(worker.scheduler_snapshot().unwrap().active_workers, 0);

        assert_eq!(
            worker.run_once().await.unwrap_err().code(),
            Some("MEDIA_LEASE_OWNER_INVALID")
        );
        assert_eq!(worker.scheduler_snapshot().unwrap().active_workers, 0);
    }
}
