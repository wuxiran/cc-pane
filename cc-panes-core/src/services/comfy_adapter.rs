//! Media provider adapter for a local or self-hosted ComfyUI API.

use super::comfy::{ComfyHistoryResult, ComfyPromptResponse, ComfyWorkflow};
use super::comfy_events::ComfyEventStream;
use super::comfy_resources::ComfySystemStats;
use super::media_provider::{
    DownloadedAsset, MediaProtocol, MediaProviderAdapter, MediaProviderCapabilities,
    MediaProviderFuture, NormalizedMediaRequest, RemoteJob, RemoteJobError, RemoteJobStatus,
    RemoteOutput,
};
use crate::models::{provider::Provider, MediaKind, MediaOperation, MediaRunStatus};
use crate::utils::error::{AppError, AppResult};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};
use url::Url;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_JSON_BYTES: u64 = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const OBJECT_INFO_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct ComfyAdapterProfile {
    pub id: String,
    pub base_url: String,
    pub client_id: String,
    pub request_timeout: Duration,
    pub max_output_bytes: u64,
}

impl fmt::Debug for ComfyAdapterProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ComfyAdapterProfile")
            .field("id", &self.id)
            .field("base_url", &self.base_url)
            .field("client_id", &self.client_id)
            .field("request_timeout", &self.request_timeout)
            .field("max_output_bytes", &self.max_output_bytes)
            .finish()
    }
}

impl ComfyAdapterProfile {
    pub fn new(id: impl Into<String>, base_url: impl Into<String>) -> AppResult<Self> {
        let profile = Self {
            id: id.into(),
            base_url: normalize_base_url(&base_url.into())?,
            client_id: format!("cc-panes-{}", uuid::Uuid::new_v4()),
            request_timeout: DEFAULT_TIMEOUT,
            max_output_bytes: MAX_OUTPUT_BYTES,
        };
        profile.validate()?;
        Ok(profile)
    }

    pub fn with_client_id(mut self, client_id: impl Into<String>) -> Self {
        self.client_id = client_id.into();
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    pub fn with_max_output_bytes(mut self, max_output_bytes: u64) -> Self {
        self.max_output_bytes = max_output_bytes;
        self
    }

    pub fn validate(&self) -> AppResult<()> {
        if self.id.trim().is_empty() || self.id.len() > 128 || self.id.chars().any(char::is_control)
        {
            return Err(AppError::coded(
                "COMFY_PROFILE_INVALID",
                "ComfyUI provider id is invalid",
            ));
        }
        let url = Url::parse(&self.base_url)
            .map_err(|_| AppError::coded("COMFY_PROFILE_INVALID", "ComfyUI base URL is invalid"))?;
        if !is_loopback_or_https(&url)
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path().contains("..")
        {
            return Err(AppError::coded(
                "COMFY_PROFILE_INVALID",
                "ComfyUI URL must be HTTPS or loopback HTTP without credentials",
            ));
        }
        if self.client_id.trim().is_empty() || self.client_id.len() > 128 {
            return Err(AppError::coded(
                "COMFY_PROFILE_INVALID",
                "ComfyUI client id is invalid",
            ));
        }
        if self.request_timeout.is_zero() || self.request_timeout > Duration::from_secs(600) {
            return Err(AppError::coded(
                "COMFY_PROFILE_INVALID",
                "ComfyUI timeout is out of range",
            ));
        }
        if self.max_output_bytes == 0 || self.max_output_bytes > MAX_OUTPUT_BYTES {
            return Err(AppError::coded(
                "COMFY_PROFILE_INVALID",
                "ComfyUI output limit is out of range",
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct ComfyMediaAdapter {
    profile: Arc<ComfyAdapterProfile>,
    client: reqwest::Client,
    submitted_kinds: Arc<RwLock<HashMap<String, MediaKind>>>,
    object_info_cache: Arc<RwLock<Option<ObjectInfoCache>>>,
}

#[derive(Clone)]
struct CachedComfyAdapter {
    base_url: String,
    adapter: Arc<ComfyMediaAdapter>,
}

/// Reuse ComfyUI adapters across schema requests and worker refreshes. The
/// cache is keyed by provider id and replaces an entry when its endpoint
/// changes, so an edited Provider never keeps talking to the old engine.
pub struct ComfyAdapterCache {
    adapters: RwLock<HashMap<String, CachedComfyAdapter>>,
}

impl Default for ComfyAdapterCache {
    fn default() -> Self {
        Self {
            adapters: RwLock::new(HashMap::new()),
        }
    }
}

impl ComfyAdapterCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn adapter_for_provider(&self, provider: &Provider) -> AppResult<Arc<ComfyMediaAdapter>> {
        let base_url = provider.base_url.as_deref().ok_or_else(|| {
            AppError::coded(
                "COMFY_PROVIDER_URL_REQUIRED",
                "ComfyUI provider has no base URL",
            )
        })?;
        self.adapter_for_profile(ComfyAdapterProfile::new(provider.id.clone(), base_url)?)
    }

    pub fn adapter_for_profile(
        &self,
        profile: ComfyAdapterProfile,
    ) -> AppResult<Arc<ComfyMediaAdapter>> {
        if let Some(cached) = self
            .adapters
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&profile.id)
            .filter(|cached| cached.base_url == profile.base_url)
        {
            return Ok(cached.adapter.clone());
        }
        let adapter = Arc::new(ComfyMediaAdapter::new(profile.clone())?);
        self.adapters
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                profile.id,
                CachedComfyAdapter {
                    base_url: profile.base_url,
                    adapter: adapter.clone(),
                },
            );
        Ok(adapter)
    }

    pub fn remove(&self, provider_id: &str) {
        self.adapters
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(provider_id);
    }
}

static SHARED_COMFY_ADAPTER_CACHE: OnceLock<ComfyAdapterCache> = OnceLock::new();

/// Process-wide cache used by the desktop command and Web daemon routes.
pub fn shared_comfy_adapter_cache() -> &'static ComfyAdapterCache {
    SHARED_COMFY_ADAPTER_CACHE.get_or_init(ComfyAdapterCache::default)
}

#[derive(Clone)]
struct ObjectInfoCache {
    value: Value,
    fetched_at: Instant,
    fingerprint: String,
}

/// The opaque file reference returned by ComfyUI's `/upload/image` endpoint.
/// Only these server-side components are persisted into a workflow; local
/// absolute paths never cross the provider boundary.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyInputRef {
    pub filename: String,
    #[serde(default)]
    pub subfolder: String,
    #[serde(rename = "type", default = "default_comfy_input_type")]
    pub input_type: String,
}

fn default_comfy_input_type() -> String {
    "input".to_string()
}

impl ComfyInputRef {
    pub fn workflow_value(&self) -> String {
        if self.subfolder.is_empty() {
            self.filename.clone()
        } else {
            format!("{}/{}", self.subfolder, self.filename)
        }
    }
}

impl fmt::Debug for ComfyMediaAdapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ComfyMediaAdapter")
            .field("profile", &self.profile)
            .finish()
    }
}

impl ComfyMediaAdapter {
    pub fn new(profile: ComfyAdapterProfile) -> AppResult<Self> {
        profile.validate()?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(profile.request_timeout)
            .build()
            .map_err(|_| {
                AppError::coded(
                    "COMFY_CLIENT_INVALID",
                    "failed to create ComfyUI HTTP client",
                )
            })?;
        Ok(Self {
            profile: Arc::new(profile),
            client,
            submitted_kinds: Arc::new(RwLock::new(HashMap::new())),
            object_info_cache: Arc::new(RwLock::new(None)),
        })
    }

    pub fn with_client(client: reqwest::Client, profile: ComfyAdapterProfile) -> AppResult<Self> {
        profile.validate()?;
        Ok(Self {
            profile: Arc::new(profile),
            client,
            submitted_kinds: Arc::new(RwLock::new(HashMap::new())),
            object_info_cache: Arc::new(RwLock::new(None)),
        })
    }

    pub fn profile(&self) -> &ComfyAdapterProfile {
        &self.profile
    }

    /// Construct a ComfyUI adapter from the existing provider snapshot. API
    /// keys are intentionally not copied into this adapter because ComfyUI's
    /// boundary is authenticated by the configured endpoint, not by the
    /// OpenAI-compatible provider credential.
    pub fn from_provider(provider: &Provider) -> AppResult<Self> {
        let base_url = provider.base_url.as_deref().ok_or_else(|| {
            AppError::coded(
                "COMFY_PROVIDER_URL_REQUIRED",
                "ComfyUI provider has no base URL",
            )
        })?;
        Self::new(ComfyAdapterProfile::new(provider.id.clone(), base_url)?)
    }

    /// Open ComfyUI's event stream with this adapter's stable client id.
    /// The returned stream is transport-only; callers must keep history
    /// polling as the source of truth for terminal outputs.
    pub async fn connect_events(&self) -> AppResult<ComfyEventStream> {
        ComfyEventStream::connect_with_timeout(
            &self.profile.base_url,
            &self.profile.client_id,
            self.profile.request_timeout.min(Duration::from_secs(30)),
        )
        .await
    }

    pub fn websocket_url(&self) -> AppResult<Url> {
        super::comfy_events::comfy_websocket_url(&self.profile.base_url, &self.profile.client_id)
    }

    /// Fetch and cache ComfyUI node capabilities. The cache is deliberately
    /// short-lived because custom-node installations can change while the app
    /// remains open. The fingerprint lets callers invalidate UI bindings when
    /// the schema changes.
    pub async fn object_info(&self) -> AppResult<(Value, String)> {
        if let Some(cache) = self
            .object_info_cache
            .read()
            .ok()
            .and_then(|cache| cache.clone())
            .filter(|cache| cache.fetched_at.elapsed() < OBJECT_INFO_CACHE_TTL)
        {
            return Ok((cache.value, cache.fingerprint));
        }
        let value = self
            .request_json(self.client.get(self.endpoint("/object_info")?), None)
            .await?;
        if !value.is_object() {
            return Err(AppError::coded(
                "COMFY_OBJECT_INFO_INVALID",
                "ComfyUI object_info response must be an object",
            ));
        }
        let fingerprint = super::comfy::json_fingerprint(&value).map_err(|_| {
            AppError::coded(
                "COMFY_OBJECT_INFO_INVALID",
                "ComfyUI object_info response is not serializable",
            )
        })?;
        let cache = ObjectInfoCache {
            value: value.clone(),
            fetched_at: Instant::now(),
            fingerprint: fingerprint.clone(),
        };
        *self
            .object_info_cache
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(cache);
        Ok((value, fingerprint))
    }

    pub async fn object_info_for_node(&self, class_type: &str) -> AppResult<Option<Value>> {
        validate_node_class(class_type)?;
        let (value, _) = self.object_info().await?;
        Ok(value.get(class_type).cloned())
    }

    pub fn clear_object_info_cache(&self) {
        *self
            .object_info_cache
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// Read the provider's normalized system and device resource snapshot.
    /// ComfyUI's raw response is projected through a whitelist so fields such
    /// as process arguments never cross the application boundary.
    pub async fn system_stats(&self) -> AppResult<ComfySystemStats> {
        let value = self
            .request_json(self.client.get(self.endpoint("/system_stats")?), None)
            .await?;
        ComfySystemStats::from_value(self.profile.id.clone(), &value)
    }

    /// Ask ComfyUI to release model memory. At least one action is required so
    /// an accidental empty request cannot be mistaken for a successful release.
    pub async fn free_memory(&self, unload_models: bool, free_memory: bool) -> AppResult<()> {
        if !unload_models && !free_memory {
            return Err(AppError::coded(
                "COMFY_FREE_REQUEST_EMPTY",
                "select unloading models or freeing memory",
            ));
        }
        self.request_empty(
            self.client.post(self.endpoint("/free")?),
            json!({
                "unload_models": unload_models,
                "free_memory": free_memory,
            }),
        )
        .await
    }

    /// Upload a controlled input asset and return only ComfyUI's opaque file
    /// reference. The endpoint is named `upload/image` in ComfyUI even though
    /// video-capable custom nodes may accept other media MIME types too.
    pub async fn upload_input(
        &self,
        filename: &str,
        mime_type: &str,
        bytes: Vec<u8>,
        overwrite: bool,
    ) -> AppResult<ComfyInputRef> {
        validate_upload_filename(filename)?;
        let mime_type = mime_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if (!mime_type.starts_with("image/") && !mime_type.starts_with("video/"))
            || mime_type == "image/svg+xml"
        {
            return Err(AppError::coded(
                "COMFY_UPLOAD_MIME_INVALID",
                "ComfyUI input MIME type is unsupported",
            ));
        }
        if bytes.is_empty() || bytes.len() > MAX_UPLOAD_BYTES {
            return Err(AppError::coded(
                "COMFY_UPLOAD_TOO_LARGE",
                "ComfyUI input exceeds the size limit",
            ));
        }
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(filename.to_string())
            .mime_str(&mime_type)
            .map_err(|_| {
                AppError::coded(
                    "COMFY_UPLOAD_MIME_INVALID",
                    "ComfyUI input MIME type is invalid",
                )
            })?;
        let form = reqwest::multipart::Form::new()
            .part("image", part)
            .text("overwrite", overwrite.to_string())
            .text("type", "input");
        let response = self
            .client
            .post(self.endpoint("/upload/image")?)
            .multipart(form)
            .send()
            .await
            .map_err(http_error)?;
        if !response.status().is_success() {
            return Err(http_status_error(response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_JSON_BYTES)
        {
            return Err(AppError::coded(
                "COMFY_RESPONSE_TOO_LARGE",
                "ComfyUI upload response is too large",
            ));
        }
        let bytes = response.bytes().await.map_err(http_error)?;
        if bytes.len() as u64 > MAX_JSON_BYTES {
            return Err(AppError::coded(
                "COMFY_RESPONSE_TOO_LARGE",
                "ComfyUI upload response is too large",
            ));
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
            AppError::coded(
                "COMFY_UPLOAD_INVALID",
                "ComfyUI upload response is not valid JSON",
            )
        })?;
        parse_input_ref(&value)
    }

    async fn submit_inner(&self, request: NormalizedMediaRequest) -> AppResult<RemoteJob> {
        request.validate()?;
        let mut workflow_value = workflow_value(&request.parameters)?;
        // Validate the user-supplied graph before uploading any input bytes;
        // malformed workflows must not leave orphaned files in ComfyUI input.
        let source_workflow = ComfyWorkflow::from_value(&workflow_value)?;
        validate_declared_workflow_fingerprint(&request.parameters, &source_workflow)?;
        let workflow_fingerprint = source_workflow.fingerprint()?;
        let uploaded_inputs = self.upload_request_inputs(&request).await?;
        apply_input_bindings(&mut workflow_value, &request.parameters, &uploaded_inputs)?;
        apply_generation_parameters(
            &mut workflow_value,
            &request.parameters,
            request.prompt.as_deref(),
        )?;
        let workflow = ComfyWorkflow::from_value(&workflow_value)?;
        let submitted_workflow_fingerprint = workflow.fingerprint()?;
        let partial_execution_targets = partial_execution_targets(&request.parameters, &workflow)?;
        let mut body = json!({
            "prompt": workflow.to_value(),
            "client_id": self.profile.client_id,
            "extra_data": {
                "cc_panes": {
                    "operation": request.operation.as_str(),
                    "kind": request.kind.as_str(),
                    "client_request_id": request.client_request_id,
                    "workflow_schema_version": super::comfy::COMFY_WORKFLOW_SCHEMA_VERSION,
                    "workflow_fingerprint": workflow_fingerprint,
                    "submitted_workflow_fingerprint": submitted_workflow_fingerprint,
                    "input_refs": uploaded_inputs,
                    "input_roles": request
                        .input_assets
                        .iter()
                        .map(|input| {
                            input
                                .metadata
                                .get("role")
                                .or_else(|| input.metadata.get("assetRole"))
                                .cloned()
                                .unwrap_or(Value::Null)
                        })
                        .collect::<Vec<_>>(),
                }
            }
        });
        if let Some(targets) = partial_execution_targets {
            body["partial_execution_targets"] =
                Value::Array(targets.into_iter().map(Value::String).collect());
        }
        if let Some(extra) = request.parameters.get("extra_data") {
            body["extra_data"] = merge_extra_data(body["extra_data"].clone(), extra.clone());
        }
        let value = self
            .request_json(self.client.post(self.endpoint("/prompt")?), Some(body))
            .await?;
        let response = ComfyPromptResponse::parse(&value)?;
        if !response.node_errors.is_null()
            && response
                .node_errors
                .as_object()
                .is_some_and(|errors| !errors.is_empty())
        {
            return Err(AppError::coded(
                "COMFY_PROMPT_REJECTED",
                "ComfyUI rejected one or more workflow nodes",
            ));
        }
        self.submitted_kinds
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(response.prompt_id.clone(), request.kind);
        Ok(RemoteJob {
            id: response.prompt_id.clone(),
            status_url: Some(
                self.endpoint(&format!(
                    "/history/{}",
                    urlencoding::encode(&response.prompt_id)
                ))?
                .to_string(),
            ),
            cancel_url: Some(self.endpoint("/interrupt")?.to_string()),
            status: MediaRunStatus::Processing,
            progress: Some(0),
            outputs: Vec::new(),
            error: None,
        })
    }

    async fn upload_request_inputs(
        &self,
        request: &NormalizedMediaRequest,
    ) -> AppResult<Vec<ComfyInputRef>> {
        let mut refs = Vec::with_capacity(request.input_assets.len());
        for (index, input) in request.input_assets.iter().enumerate() {
            let data = input.data.as_deref().ok_or_else(|| {
                AppError::coded(
                    "COMFY_UPLOAD_INPUT_REQUIRED",
                    "ComfyUI input assets must be staged bytes",
                )
            })?;
            let bytes = decode_input_data(data)?;
            let mime = input
                .mime_type
                .as_deref()
                .unwrap_or("application/octet-stream");
            let filename = input
                .metadata
                .get("filename")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(sanitize_upload_filename)
                .unwrap_or_else(|| {
                    let extension = match mime {
                        value if value.eq_ignore_ascii_case("image/png") => "png",
                        value if value.eq_ignore_ascii_case("image/jpeg") => "jpg",
                        value if value.eq_ignore_ascii_case("image/webp") => "webp",
                        value if value.eq_ignore_ascii_case("image/gif") => "gif",
                        value if value.eq_ignore_ascii_case("video/mp4") => "mp4",
                        value if value.eq_ignore_ascii_case("video/webm") => "webm",
                        value if value.eq_ignore_ascii_case("video/quicktime") => "mov",
                        _ => "bin",
                    };
                    format!("cc-panes-input-{index}.{extension}")
                });
            refs.push(self.upload_input(&filename, mime, bytes, false).await?);
        }
        Ok(refs)
    }

    async fn poll_inner(
        &self,
        job: &RemoteJob,
        expected_kind: Option<MediaKind>,
    ) -> AppResult<RemoteJobStatus> {
        if job.status.is_terminal() && job.status_url.is_none() {
            return Ok(RemoteJobStatus {
                id: job.id.clone(),
                status: job.status,
                status_url: None,
                cancel_url: job.cancel_url.clone(),
                progress: job.progress,
                outputs: job.outputs.clone(),
                error: job.error.clone(),
            });
        }
        let kind = expected_kind
            .or_else(|| {
                self.submitted_kinds
                    .read()
                    .ok()
                    .and_then(|map| map.get(&job.id).copied())
            })
            .unwrap_or(MediaKind::Image);
        let value = self
            .request_json(
                self.client
                    .get(self.endpoint(&format!("/history/{}", urlencoding::encode(&job.id)))?),
                None,
            )
            .await?;
        if value.as_object().is_some_and(|object| object.is_empty()) {
            return Ok(RemoteJobStatus {
                id: job.id.clone(),
                status: MediaRunStatus::Processing,
                status_url: job.status_url.clone(),
                cancel_url: job.cancel_url.clone(),
                progress: job.progress,
                outputs: Vec::new(),
                error: None,
            });
        }
        let history = ComfyHistoryResult::parse(&value, &job.id, kind)?;
        let outputs = history
            .outputs
            .iter()
            .map(|output| self.output_to_remote(output))
            .collect::<AppResult<Vec<_>>>()?;
        let error = history.error_message.map(|message| RemoteJobError {
            code: Some("COMFY_EXECUTION_ERROR".to_string()),
            message,
        });
        if history.status.is_terminal() {
            self.submitted_kinds
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&job.id);
        }
        Ok(RemoteJobStatus {
            id: history.prompt_id,
            status: history.status,
            status_url: job.status_url.clone(),
            cancel_url: job.cancel_url.clone(),
            progress: if history.status == MediaRunStatus::Succeeded {
                Some(100)
            } else {
                job.progress
            },
            outputs,
            error,
        })
    }

    async fn cancel_inner(&self, job: &RemoteJob) -> AppResult<()> {
        if job.status.is_terminal() {
            return Ok(());
        }
        let body = json!({ "prompt_id": job.id });
        let _ = self
            .request_empty(self.client.post(self.endpoint("/interrupt")?), body)
            .await;
        // interrupt covers running prompts; deleting from the queue covers
        // prompts that have not started yet. Both endpoints are idempotent.
        let _ = self
            .request_empty(
                self.client.post(self.endpoint("/queue")?),
                json!({ "delete": [job.id] }),
            )
            .await;
        self.submitted_kinds
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&job.id);
        Ok(())
    }

    async fn download_inner(&self, output: &RemoteOutput) -> AppResult<DownloadedAsset> {
        let raw_url = output.url.as_deref().ok_or_else(|| {
            AppError::coded("COMFY_OUTPUT_INVALID", "ComfyUI output has no view URL")
        })?;
        let url = Url::parse(raw_url).map_err(|_| {
            AppError::coded("COMFY_OUTPUT_INVALID", "ComfyUI output URL is invalid")
        })?;
        let base = Url::parse(&self.profile.base_url)
            .map_err(|_| AppError::coded("COMFY_PROFILE_INVALID", "ComfyUI base URL is invalid"))?;
        if url.scheme() != base.scheme()
            || url.host_str() != base.host_str()
            || url.port_or_known_default() != base.port_or_known_default()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(AppError::coded(
                "COMFY_OUTPUT_REJECTED",
                "ComfyUI output URL is outside the configured engine",
            ));
        }
        let response = self
            .client
            .get(url.clone())
            .header(ACCEPT, "*/*")
            .send()
            .await
            .map_err(http_error)?;
        if !response.status().is_success() {
            return Err(http_status_error(response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|size| size > self.profile.max_output_bytes)
        {
            return Err(AppError::coded(
                "COMFY_OUTPUT_TOO_LARGE",
                "ComfyUI output exceeds the configured size limit",
            ));
        }
        let mut bytes = Vec::new();
        let mut response = response;
        while let Some(chunk) = response.chunk().await.map_err(http_error)? {
            if bytes.len() as u64 + chunk.len() as u64 > self.profile.max_output_bytes {
                return Err(AppError::coded(
                    "COMFY_OUTPUT_TOO_LARGE",
                    "ComfyUI output exceeds the configured size limit",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let mime = output
            .mime_type
            .as_deref()
            .or_else(|| mime_from_filename(output.filename.as_deref()))
            .unwrap_or(match output.kind.unwrap_or(MediaKind::Image) {
                MediaKind::Image => "image/png",
                MediaKind::Video => "video/mp4",
            })
            .to_string();
        if !mime.starts_with("image/") && !mime.starts_with("video/") {
            return Err(AppError::coded(
                "COMFY_OUTPUT_INVALID",
                "ComfyUI output MIME type is unsupported",
            ));
        }
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Ok(DownloadedAsset {
            size_bytes: bytes.len() as u64,
            bytes,
            mime_type: mime,
            sha256: format!("{:x}", hasher.finalize()),
            filename: output.filename.clone(),
            source_url: Some(format!(
                "{}{}",
                url.origin().ascii_serialization(),
                url.path()
            )),
            metadata: output.metadata.clone(),
        })
    }

    fn output_to_remote(&self, output: &super::comfy::ComfyOutputRef) -> AppResult<RemoteOutput> {
        let query = output.view_query()?;
        let url = self.endpoint(&format!("/view?{query}"))?;
        Ok(RemoteOutput {
            url: Some(url.to_string()),
            b64_json: None,
            mime_type: mime_from_filename(Some(&output.filename)).map(str::to_string),
            filename: Some(output.filename.clone()),
            kind: Some(output.kind),
            metadata: output.metadata.clone(),
        })
    }

    fn endpoint(&self, path: &str) -> AppResult<Url> {
        let base = Url::parse(&self.profile.base_url)
            .map_err(|_| AppError::coded("COMFY_PROFILE_INVALID", "ComfyUI base URL is invalid"))?;
        base.join(path.trim_start_matches('/')).map_err(|_| {
            AppError::coded("COMFY_PROFILE_INVALID", "ComfyUI endpoint path is invalid")
        })
    }

    async fn request_json(
        &self,
        builder: reqwest::RequestBuilder,
        body: Option<Value>,
    ) -> AppResult<Value> {
        let response = match body {
            Some(body) => {
                builder
                    .header(CONTENT_TYPE, "application/json")
                    .json(&body)
                    .send()
                    .await
            }
            None => builder.header(ACCEPT, "application/json").send().await,
        }
        .map_err(http_error)?;
        if !response.status().is_success() {
            return Err(http_status_error(response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_JSON_BYTES)
        {
            return Err(AppError::coded(
                "COMFY_RESPONSE_TOO_LARGE",
                "ComfyUI JSON response is too large",
            ));
        }
        let bytes = response.bytes().await.map_err(http_error)?;
        if bytes.len() as u64 > MAX_JSON_BYTES {
            return Err(AppError::coded(
                "COMFY_RESPONSE_TOO_LARGE",
                "ComfyUI JSON response is too large",
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| AppError::coded("COMFY_RESPONSE_INVALID", "ComfyUI returned invalid JSON"))
    }

    async fn request_empty(&self, builder: reqwest::RequestBuilder, body: Value) -> AppResult<()> {
        let response = builder
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(http_error)?;
        if !response.status().is_success() {
            return Err(http_status_error(response.status().as_u16()));
        }
        Ok(())
    }
}

/// Apply provider-neutral controls to conventional ComfyUI inputs. The
/// adapter only overwrites a field when the workflow already exposes that
/// field, so custom nodes remain authoritative. Text encoder prompts are
/// updated only for nodes whose title/class identifies a positive or negative
/// encoder; arbitrary text inputs are never guessed.
fn apply_generation_parameters(
    workflow: &mut Value,
    parameters: &Value,
    prompt: Option<&str>,
) -> AppResult<()> {
    let Some(object) = parameters.as_object() else {
        return Ok(());
    };
    let seed =
        parameter_value(object, &["seed", "noiseSeed", "noise_seed"]).filter(Value::is_number);
    let batch_size = parameter_value(object, &["batchSize", "batch_size", "n"])
        .and_then(|value| value.as_u64())
        .filter(|value| *value > 0 && *value <= 64)
        .map(|value| Value::Number(value.into()));
    let steps = parameter_value(object, &["steps"]);
    let cfg = parameter_value(object, &["cfgScale", "cfg_scale", "cfg"]);
    let sampler = parameter_value(object, &["sampler", "samplerName", "sampler_name"]);
    let scheduler = parameter_value(object, &["scheduler"]);
    let denoise = parameter_value(object, &["denoise"]);
    let frame_count = parameter_value(object, &["frameCount", "frame_count", "frames"]);
    let fps = parameter_value(object, &["fps", "frameRate", "frame_rate"]);
    let audio = parameter_value(object, &["audio", "hasAudio", "has_audio"]);
    let codec = parameter_value(object, &["codec", "videoCodec", "video_codec"]);
    let color_space = parameter_value(object, &["colorSpace", "color_space", "colorspace"]);
    let (width, height) = object
        .get("size")
        .and_then(Value::as_str)
        .and_then(parse_dimensions)
        .map(|(width, height)| (Value::Number(width.into()), Value::Number(height.into())))
        .unwrap_or((Value::Null, Value::Null));
    let negative_prompt = object
        .get("negativePrompt")
        .or_else(|| object.get("negative_prompt"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(nodes) = workflow.as_object_mut() else {
        return Err(AppError::coded(
            "COMFY_WORKFLOW_INVALID",
            "ComfyUI workflow must be an object",
        ));
    };
    for node in nodes.values_mut() {
        let class_type = node
            .get("class_type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let title = node
            .get("_meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("title"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let Some(inputs) = node.get_mut("inputs").and_then(Value::as_object_mut) else {
            continue;
        };
        if let Some(seed) = seed.clone() {
            overwrite_if_present(
                inputs,
                &[
                    "seed",
                    "noise_seed",
                    "noiseSeed",
                    "random_seed",
                    "randomSeed",
                ],
                seed,
            );
        }
        if let Some(batch_size) = batch_size.clone() {
            overwrite_if_present(inputs, &["batch_size", "batchSize", "batch"], batch_size);
        }
        if let Some(steps) = steps.clone() {
            overwrite_if_present(inputs, &["steps"], steps);
        }
        if let Some(cfg) = cfg.clone() {
            overwrite_if_present(inputs, &["cfg", "cfg_scale", "guidance_scale"], cfg);
        }
        if let Some(sampler) = sampler.clone() {
            overwrite_if_present(inputs, &["sampler_name", "sampler"], sampler);
        }
        if let Some(scheduler) = scheduler.clone() {
            overwrite_if_present(inputs, &["scheduler"], scheduler);
        }
        if let Some(denoise) = denoise.clone() {
            overwrite_if_present(inputs, &["denoise"], denoise);
        }
        if !width.is_null() {
            overwrite_if_present(inputs, &["width"], width.clone());
        }
        if !height.is_null() {
            overwrite_if_present(inputs, &["height"], height.clone());
        }
        if let Some(frame_count) = frame_count.clone() {
            overwrite_if_present(
                inputs,
                &["length", "frames", "frame_count", "num_frames"],
                frame_count,
            );
        }
        if let Some(fps) = fps.clone() {
            overwrite_if_present(inputs, &["frame_rate", "fps", "frameRate"], fps);
        }
        if let Some(audio) = audio.clone() {
            overwrite_if_present(inputs, &["audio", "include_audio", "has_audio"], audio);
        }
        if let Some(codec) = codec.clone() {
            overwrite_if_present(inputs, &["codec", "video_codec"], codec);
        }
        if let Some(color_space) = color_space.clone() {
            overwrite_if_present(
                inputs,
                &["color_space", "colorSpace", "colorspace"],
                color_space,
            );
        }
        if class_type.contains("textencode") || class_type.contains("text_encoder") {
            let negative = title.contains("negative") || class_type.contains("negative");
            if negative {
                if let Some(value) = negative_prompt.clone() {
                    overwrite_if_present(inputs, &["text"], Value::String(value));
                }
            } else if let Some(value) = prompt {
                overwrite_if_present(inputs, &["text"], Value::String(value.to_string()));
            }
        }
    }
    Ok(())
}

fn parameter_value(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<Value> {
    keys.iter().find_map(|key| object.get(*key).cloned())
}

fn overwrite_if_present(inputs: &mut serde_json::Map<String, Value>, keys: &[&str], value: Value) {
    for key in keys {
        if inputs
            .get(*key)
            .is_some_and(|current| !is_comfy_link(current))
        {
            inputs.insert((*key).to_string(), value.clone());
        }
    }
}

fn is_comfy_link(value: &Value) -> bool {
    value.as_array().is_some_and(|link| {
        link.len() == 2
            && (link[0].is_string() || link[0].is_i64())
            && link[1].as_i64().is_some_and(|index| index >= 0)
    })
}

fn parse_dimensions(value: &str) -> Option<(i64, i64)> {
    let (width, height) = value.split_once('x')?;
    let width = width.parse::<i64>().ok()?;
    let height = height.parse::<i64>().ok()?;
    (width > 0 && height > 0 && width <= 16_384 && height <= 16_384).then_some((width, height))
}

/// Translate CC-Panes' optional partial-run hint to ComfyUI's native
/// `partial_execution_targets` field. The target list is validated against
/// the final workflow before it is sent, so a stale Canvas edge fails locally
/// instead of silently running the whole graph.
fn partial_execution_targets(
    parameters: &Value,
    workflow: &ComfyWorkflow,
) -> AppResult<Option<Vec<String>>> {
    let Some(object) = parameters.as_object() else {
        return Ok(None);
    };
    let Some(raw) = object
        .get("partialExecutionTargets")
        .or_else(|| object.get("partial_execution_targets"))
        .or_else(|| object.get("executeOutputs"))
    else {
        return Ok(None);
    };
    let values = raw.as_array().ok_or_else(|| {
        AppError::coded(
            "COMFY_PARTIAL_TARGET_INVALID",
            "partial execution targets must be an array",
        )
    })?;
    if values.is_empty() || values.len() > 256 {
        return Err(AppError::coded(
            "COMFY_PARTIAL_TARGET_INVALID",
            "partial execution targets must contain 1..256 node ids",
        ));
    }
    let mut targets = Vec::with_capacity(values.len());
    for value in values {
        let target = value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_i64().map(|id| id.to_string()))
            .ok_or_else(|| {
                AppError::coded(
                    "COMFY_PARTIAL_TARGET_INVALID",
                    "partial execution target must be a node id",
                )
            })?;
        if !workflow.nodes.contains_key(&target) {
            return Err(AppError::coded(
                "COMFY_PARTIAL_TARGET_INVALID",
                format!("partial execution target {target} is not in the workflow"),
            ));
        }
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    Ok(Some(targets))
}

impl MediaProviderAdapter for ComfyMediaAdapter {
    fn provider_id(&self) -> &str {
        &self.profile.id
    }

    fn protocol(&self) -> MediaProtocol {
        MediaProtocol::ComfyUi
    }

    fn capabilities(&self) -> MediaProviderCapabilities {
        MediaProviderCapabilities {
            provider_id: self.profile.id.clone(),
            protocol: self.protocol(),
            kinds: vec![MediaKind::Image, MediaKind::Video],
            operations: vec![
                MediaOperation::TextToImage,
                MediaOperation::ImageToImage,
                MediaOperation::TextToVideo,
                MediaOperation::ImageToVideo,
                MediaOperation::Edit,
                MediaOperation::Upscale,
                MediaOperation::Extend,
            ],
            supports_async_jobs: true,
            supports_cancel: true,
        }
    }

    fn submit<'a>(&'a self, request: NormalizedMediaRequest) -> MediaProviderFuture<'a, RemoteJob> {
        Box::pin(self.submit_inner(request))
    }

    fn poll<'a>(&'a self, job: &'a RemoteJob) -> MediaProviderFuture<'a, RemoteJobStatus> {
        Box::pin(self.poll_inner(job, None))
    }

    fn poll_for_kind<'a>(
        &'a self,
        job: &'a RemoteJob,
        kind: MediaKind,
    ) -> MediaProviderFuture<'a, RemoteJobStatus> {
        Box::pin(self.poll_inner(job, Some(kind)))
    }

    fn cancel<'a>(&'a self, job: &'a RemoteJob) -> MediaProviderFuture<'a, ()> {
        Box::pin(self.cancel_inner(job))
    }

    fn download<'a>(
        &'a self,
        output: &'a RemoteOutput,
    ) -> MediaProviderFuture<'a, DownloadedAsset> {
        Box::pin(self.download_inner(output))
    }
}

fn workflow_value(parameters: &Value) -> AppResult<Value> {
    let object = parameters.as_object().ok_or_else(|| {
        AppError::coded(
            "COMFY_WORKFLOW_REQUIRED",
            "ComfyUI parameters must contain an API workflow",
        )
    })?;
    if let Some(value) = object
        .get("workflow")
        .or_else(|| object.get("comfyWorkflow"))
        .or_else(|| object.get("prompt"))
    {
        return Ok(value.clone());
    }
    if object
        .values()
        .any(|value| value.get("class_type").is_some())
    {
        return Ok(parameters.clone());
    }
    Err(AppError::coded(
        "COMFY_WORKFLOW_REQUIRED",
        "ComfyUI generation requires an API-format workflow",
    ))
}

fn validate_declared_workflow_fingerprint(
    parameters: &Value,
    workflow: &ComfyWorkflow,
) -> AppResult<()> {
    let Some(expected) = parameters
        .get("workflowFingerprint")
        .or_else(|| parameters.get("workflow_fingerprint"))
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    if expected.len() != 64
        || !expected
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(AppError::coded(
            "COMFY_WORKFLOW_CHECKSUM_INVALID",
            "ComfyUI workflow fingerprint must be a SHA-256 value",
        ));
    }
    let actual = workflow.fingerprint()?;
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(AppError::coded(
            "COMFY_WORKFLOW_CHECKSUM_MISMATCH",
            "ComfyUI workflow changed after its fingerprint was calculated",
        ));
    }
    Ok(())
}

fn decode_input_data(value: &str) -> AppResult<Vec<u8>> {
    let encoded = value
        .strip_prefix("data:")
        .and_then(|value| value.split_once(',').map(|(_, data)| data))
        .unwrap_or(value)
        .trim();
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
        .or_else(|_| {
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, encoded)
        })
        .map_err(|_| {
            AppError::coded(
                "COMFY_UPLOAD_INPUT_INVALID",
                "ComfyUI input is not valid base64",
            )
        })?;
    if bytes.is_empty() || bytes.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::coded(
            "COMFY_UPLOAD_TOO_LARGE",
            "ComfyUI input exceeds the size limit",
        ));
    }
    Ok(bytes)
}

fn sanitize_upload_filename(value: &str) -> String {
    let component = value.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut result = component
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if result.is_empty() || result == "." || result == ".." {
        result = "cc-panes-input.bin".to_string();
    }
    result.chars().take(128).collect()
}

fn validate_upload_filename(value: &str) -> AppResult<()> {
    if value.trim().is_empty()
        || value.len() > 256
        || value.contains('/')
        || value.contains('\\')
        || value.contains("..")
        || value.chars().any(char::is_control)
    {
        return Err(AppError::coded(
            "COMFY_UPLOAD_FILENAME_INVALID",
            "ComfyUI upload filename is unsafe",
        ));
    }
    Ok(())
}

fn validate_node_class(value: &str) -> AppResult<()> {
    if value.trim().is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err(AppError::coded(
            "COMFY_NODE_CLASS_INVALID",
            "ComfyUI node class is invalid",
        ));
    }
    Ok(())
}

fn parse_input_ref(value: &Value) -> AppResult<ComfyInputRef> {
    let object = value.as_object().ok_or_else(|| {
        AppError::coded(
            "COMFY_UPLOAD_INVALID",
            "ComfyUI upload response must be an object",
        )
    })?;
    let filename = object
        .get("filename")
        .or_else(|| object.get("name"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::coded(
                "COMFY_UPLOAD_INVALID",
                "ComfyUI upload response has no filename",
            )
        })?;
    validate_upload_component(filename, "filename")?;
    let subfolder = object
        .get("subfolder")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !subfolder.is_empty() {
        validate_upload_component(subfolder, "subfolder")?;
    }
    let input_type = object
        .get("type")
        .or_else(|| object.get("output_type"))
        .and_then(Value::as_str)
        .unwrap_or("input");
    if !matches!(input_type, "input" | "temp" | "output") {
        return Err(AppError::coded(
            "COMFY_UPLOAD_INVALID",
            "ComfyUI upload response has an invalid type",
        ));
    }
    Ok(ComfyInputRef {
        filename: filename.to_string(),
        subfolder: subfolder.to_string(),
        input_type: input_type.to_string(),
    })
}

fn validate_upload_component(value: &str, field: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.contains("..")
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(AppError::coded(
            "COMFY_UPLOAD_INVALID",
            format!("ComfyUI upload {field} is unsafe"),
        ));
    }
    Ok(())
}

fn apply_input_bindings(
    workflow: &mut Value,
    parameters: &Value,
    refs: &[ComfyInputRef],
) -> AppResult<()> {
    apply_mask_binding(workflow, parameters, refs)?;
    if let Some(bindings) = parameters
        .get("inputBindings")
        .or_else(|| parameters.get("input_bindings"))
    {
        let bindings = bindings.as_array().ok_or_else(|| {
            AppError::coded(
                "COMFY_INPUT_BINDINGS_INVALID",
                "ComfyUI inputBindings must be an array",
            )
        })?;
        for binding in bindings {
            let object = binding.as_object().ok_or_else(|| {
                AppError::coded(
                    "COMFY_INPUT_BINDINGS_INVALID",
                    "ComfyUI input binding must be an object",
                )
            })?;
            let node_id = object
                .get("nodeId")
                .or_else(|| object.get("node_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::coded(
                        "COMFY_INPUT_BINDINGS_INVALID",
                        "ComfyUI input binding has no nodeId",
                    )
                })?;
            let input_name = object
                .get("input")
                .or_else(|| object.get("inputName"))
                .or_else(|| object.get("input_name"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::coded(
                        "COMFY_INPUT_BINDINGS_INVALID",
                        "ComfyUI input binding has no input name",
                    )
                })?;
            if node_id.is_empty()
                || input_name.is_empty()
                || node_id.chars().any(char::is_control)
                || input_name.chars().any(char::is_control)
            {
                return Err(AppError::coded(
                    "COMFY_INPUT_BINDINGS_INVALID",
                    "ComfyUI input binding contains an invalid name",
                ));
            }
            let index = object
                .get("assetIndex")
                .or_else(|| object.get("asset_index"))
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    AppError::coded(
                        "COMFY_INPUT_BINDINGS_INVALID",
                        "ComfyUI input binding has no assetIndex",
                    )
                })? as usize;
            let reference = refs.get(index).ok_or_else(|| {
                AppError::coded(
                    "COMFY_INPUT_BINDINGS_INVALID",
                    "ComfyUI input binding references a missing asset",
                )
            })?;
            let node = workflow
                .get_mut(node_id)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    AppError::coded(
                        "COMFY_INPUT_BINDINGS_INVALID",
                        "ComfyUI input binding references a missing node",
                    )
                })?;
            let inputs = node
                .entry("inputs")
                .or_insert_with(|| Value::Object(serde_json::Map::new()))
                .as_object_mut()
                .ok_or_else(|| {
                    AppError::coded(
                        "COMFY_INPUT_BINDINGS_INVALID",
                        "ComfyUI node inputs must be an object",
                    )
                })?;
            inputs.insert(
                input_name.to_string(),
                Value::String(reference.workflow_value()),
            );
        }
    }
    replace_input_placeholders(workflow, refs)
}

/// Bind the role selected by the image-edit form to conventional MASK input
/// names. Explicit `inputBindings` and `{{input:n}}` placeholders are applied
/// afterwards and therefore remain the source of truth for custom nodes.
fn apply_mask_binding(
    workflow: &mut Value,
    parameters: &Value,
    refs: &[ComfyInputRef],
) -> AppResult<()> {
    let Some(object) = parameters.as_object() else {
        return Ok(());
    };
    let Some(raw_index) = object
        .get("maskInputIndex")
        .or_else(|| object.get("mask_input_index"))
    else {
        return Ok(());
    };
    let index = raw_index.as_u64().ok_or_else(|| {
        AppError::coded(
            "COMFY_MASK_BINDING_INVALID",
            "maskInputIndex must be a non-negative integer",
        )
    })? as usize;
    let reference = refs.get(index).ok_or_else(|| {
        AppError::coded(
            "COMFY_MASK_BINDING_INVALID",
            "maskInputIndex references a missing uploaded input",
        )
    })?;
    let Some(nodes) = workflow.as_object_mut() else {
        return Err(AppError::coded(
            "COMFY_WORKFLOW_INVALID",
            "ComfyUI workflow must be an object",
        ));
    };
    for node in nodes.values_mut() {
        let Some(inputs) = node.get_mut("inputs").and_then(Value::as_object_mut) else {
            continue;
        };
        for (name, value) in inputs.iter_mut() {
            if is_mask_input_name(name) && !is_comfy_link(value) {
                *value = Value::String(reference.workflow_value());
            }
        }
    }
    Ok(())
}

fn is_mask_input_name(name: &str) -> bool {
    let normalized = name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "mask" | "maskimage" | "maskinput" | "inpaintmask" | "maskfile"
    )
}

fn replace_input_placeholders(value: &mut Value, refs: &[ComfyInputRef]) -> AppResult<()> {
    match value {
        Value::Array(values) => {
            for value in values {
                replace_input_placeholders(value, refs)?;
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                replace_input_placeholders(value, refs)?;
            }
        }
        Value::String(text) => {
            let mut output = String::with_capacity(text.len());
            let mut rest = text.as_str();
            while let Some(start) = rest.find("{{input:") {
                output.push_str(&rest[..start]);
                let tail = &rest[start + 8..];
                let end = tail.find("}}").ok_or_else(|| {
                    AppError::coded(
                        "COMFY_INPUT_BINDINGS_INVALID",
                        "ComfyUI input placeholder is not closed",
                    )
                })?;
                let token = &tail[..end];
                let mut parts = token.split('.');
                let index = parts
                    .next()
                    .and_then(|value| value.parse::<usize>().ok())
                    .ok_or_else(|| {
                        AppError::coded(
                            "COMFY_INPUT_BINDINGS_INVALID",
                            "ComfyUI input placeholder has an invalid index",
                        )
                    })?;
                let reference = refs.get(index).ok_or_else(|| {
                    AppError::coded(
                        "COMFY_INPUT_BINDINGS_INVALID",
                        "ComfyUI input placeholder references a missing asset",
                    )
                })?;
                let replacement = match parts.next() {
                    None | Some("path") => reference.workflow_value(),
                    Some("filename") => reference.filename.clone(),
                    Some("subfolder") => reference.subfolder.clone(),
                    Some("type") => reference.input_type.clone(),
                    Some(_) => {
                        return Err(AppError::coded(
                            "COMFY_INPUT_BINDINGS_INVALID",
                            "ComfyUI input placeholder field is unsupported",
                        ))
                    }
                };
                output.push_str(&replacement);
                rest = &tail[end + 2..];
            }
            output.push_str(rest);
            *text = output;
        }
        _ => {}
    }
    Ok(())
}

fn merge_extra_data(left: Value, right: Value) -> Value {
    let mut merged = left.as_object().cloned().unwrap_or_default();
    if let Some(right) = right.as_object() {
        merged.extend(right.clone());
    }
    Value::Object(merged)
}

fn normalize_base_url(value: &str) -> AppResult<String> {
    let mut url = Url::parse(value)
        .map_err(|_| AppError::coded("COMFY_PROFILE_INVALID", "ComfyUI base URL is invalid"))?;
    if !is_loopback_or_https(&url) {
        return Err(AppError::coded(
            "COMFY_PROFILE_INVALID",
            "ComfyUI base URL must be HTTPS or loopback HTTP",
        ));
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url.to_string())
}

fn is_loopback_or_https(url: &Url) -> bool {
    url.scheme() == "https"
        || (url.scheme() == "http"
            && url.host_str().is_some_and(|host| {
                host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
            }))
}

fn mime_from_filename(filename: Option<&str>) -> Option<&'static str> {
    match filename?.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),
        _ => None,
    }
}

fn http_error(error: reqwest::Error) -> AppError {
    AppError::coded("COMFY_TRANSPORT", error.to_string())
}

fn http_status_error(status: u16) -> AppError {
    AppError::coded(
        "COMFY_HTTP_ERROR",
        format!("ComfyUI returned HTTP {status}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MediaOperation;
    use crate::services::media_provider::MediaProviderAdapter;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::{timeout, Duration};

    #[test]
    fn profile_rejects_non_loopback_http() {
        assert!(ComfyAdapterProfile::new("comfy", "http://192.168.1.2:8188").is_err());
        assert!(ComfyAdapterProfile::new("comfy", "http://127.0.0.1:8188").is_ok());
    }

    #[test]
    fn workflow_is_read_from_parameters() {
        let value = workflow_value(&json!({
            "workflow": {"1": {"class_type": "SaveImage", "inputs": {}}}
        }))
        .unwrap();
        assert!(value.get("1").is_some());
        assert!(workflow_value(&json!({"prompt": "text"})).is_ok());
    }

    #[test]
    fn rejects_a_stale_declared_workflow_fingerprint() {
        let workflow = ComfyWorkflow::from_value(&json!({
            "1": { "class_type": "SaveImage", "inputs": {} }
        }))
        .unwrap();
        let expected = workflow.fingerprint().unwrap();
        validate_declared_workflow_fingerprint(
            &json!({"workflowFingerprint": expected}),
            &workflow,
        )
        .unwrap();
        assert!(validate_declared_workflow_fingerprint(
            &json!({"workflowFingerprint": "0".repeat(64)}),
            &workflow,
        )
        .is_err());
    }

    #[test]
    fn adapter_cache_reuses_same_endpoint_and_replaces_changed_endpoint() {
        let cache = ComfyAdapterCache::new();
        let first = cache
            .adapter_for_profile(
                ComfyAdapterProfile::new("provider", "http://127.0.0.1:8188").unwrap(),
            )
            .unwrap();
        let same = cache
            .adapter_for_profile(
                ComfyAdapterProfile::new("provider", "http://127.0.0.1:8188").unwrap(),
            )
            .unwrap();
        assert!(Arc::ptr_eq(&first, &same));
        let changed = cache
            .adapter_for_profile(
                ComfyAdapterProfile::new("provider", "http://127.0.0.1:8189").unwrap(),
            )
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &changed));
    }

    #[test]
    fn input_bindings_and_placeholders_use_opaque_server_refs() {
        let refs = vec![ComfyInputRef {
            filename: "reference.png".to_string(),
            subfolder: "cc-panes".to_string(),
            input_type: "input".to_string(),
        }];
        let mut workflow = json!({
            "1": {"class_type": "LoadImage", "inputs": {"image": "{{input:0}}"}},
            "2": {"class_type": "Custom", "inputs": {"value": "{{input:0.filename}}"}}
        });
        apply_input_bindings(&mut workflow, &json!({}), &refs).unwrap();
        assert_eq!(workflow["1"]["inputs"]["image"], "cc-panes/reference.png");
        assert_eq!(workflow["2"]["inputs"]["value"], "reference.png");

        let mut bound = json!({"1": {"class_type": "LoadImage", "inputs": {}}});
        apply_input_bindings(
            &mut bound,
            &json!({"inputBindings":[{"nodeId":"1","input":"image","assetIndex":0}]}),
            &refs,
        )
        .unwrap();
        assert_eq!(bound["1"]["inputs"]["image"], "cc-panes/reference.png");
    }

    #[test]
    fn mask_input_index_binds_conventional_mask_fields_before_explicit_overrides() {
        let refs = vec![
            ComfyInputRef {
                filename: "source.png".to_string(),
                subfolder: "cc-panes".to_string(),
                input_type: "input".to_string(),
            },
            ComfyInputRef {
                filename: "mask.png".to_string(),
                subfolder: "cc-panes".to_string(),
                input_type: "input".to_string(),
            },
        ];
        let mut workflow = json!({
            "1": {"class_type": "Inpaint", "inputs": {"image": "{{input:0}}", "mask": ""}},
            "2": {"class_type": "Custom", "inputs": {"mask_image": ""}}
        });
        apply_input_bindings(&mut workflow, &json!({"maskInputIndex": 1}), &refs).unwrap();
        assert_eq!(workflow["1"]["inputs"]["mask"], "cc-panes/mask.png");
        assert_eq!(workflow["2"]["inputs"]["mask_image"], "cc-panes/mask.png");

        apply_input_bindings(
            &mut workflow,
            &json!({
                "maskInputIndex": 1,
                "inputBindings": [{"nodeId": "1", "input": "mask", "assetIndex": 0}]
            }),
            &refs,
        )
        .unwrap();
        assert_eq!(workflow["1"]["inputs"]["mask"], "cc-panes/source.png");
    }

    #[test]
    fn mask_input_index_rejects_missing_reference() {
        let mut workflow = json!({"1": {"class_type": "Inpaint", "inputs": {"mask": ""}}});
        let error = apply_input_bindings(
            &mut workflow,
            &json!({"maskInputIndex": 1}),
            &[ComfyInputRef {
                filename: "mask.png".to_string(),
                subfolder: String::new(),
                input_type: "input".to_string(),
            }],
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("COMFY_MASK_BINDING_INVALID"));
    }

    #[test]
    fn generation_parameters_override_common_sampler_seed_and_batch_inputs() {
        let mut workflow = json!({
            "1": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20, "cfg": 4.0, "sampler_name": "euler", "denoise": 1.0}},
            "2": {"class_type": "EmptyLatentImage", "inputs": {"batch_size": 1, "width": 512, "height": 512}},
            "3": {"class_type": "CLIPTextEncode", "_meta": {"title": "Positive Prompt"}, "inputs": {"text": "old"}},
            "4": {"class_type": "CLIPTextEncode", "_meta": {"title": "Negative Prompt"}, "inputs": {"text": "old negative"}},
            "5": {"class_type": "Custom", "inputs": {"value": "keep"}},
            "6": {"class_type": "Custom", "inputs": {"seed": ["5", 0], "text": ["5", 1]}}
        });
        apply_generation_parameters(
            &mut workflow,
            &json!({
                "seed": 9876,
                "batchSize": 4,
                "steps": 32,
                "cfgScale": 6.5,
                "sampler": "dpmpp_2m",
                "denoise": 0.7,
                "negativePrompt": "blurry",
                "size": "1024x768"
            }),
            Some("a sharp subject"),
        )
        .unwrap();
        assert_eq!(workflow["1"]["inputs"]["seed"], 9876);
        assert_eq!(workflow["1"]["inputs"]["steps"], 32);
        assert_eq!(workflow["1"]["inputs"]["cfg"], 6.5);
        assert_eq!(workflow["1"]["inputs"]["sampler_name"], "dpmpp_2m");
        assert_eq!(workflow["1"]["inputs"]["denoise"], 0.7);
        assert_eq!(workflow["2"]["inputs"]["batch_size"], 4);
        assert_eq!(workflow["2"]["inputs"]["width"], 1024);
        assert_eq!(workflow["2"]["inputs"]["height"], 768);
        assert_eq!(workflow["3"]["inputs"]["text"], "a sharp subject");
        assert_eq!(workflow["4"]["inputs"]["text"], "blurry");
        assert_eq!(workflow["5"]["inputs"]["value"], "keep");
        assert_eq!(workflow["6"]["inputs"]["seed"], json!(["5", 0]));
        assert_eq!(workflow["6"]["inputs"]["text"], json!(["5", 1]));
    }

    #[test]
    fn partial_execution_targets_are_validated_against_final_workflow() {
        let workflow = ComfyWorkflow::from_value(&json!({
            "1": {"class_type": "SaveImage", "inputs": {}},
            "2": {"class_type": "PreviewImage", "inputs": {}}
        }))
        .unwrap();
        assert_eq!(
            partial_execution_targets(&json!({"executeOutputs": ["2", "2"]}), &workflow).unwrap(),
            Some(vec!["2".to_string()])
        );
        let error =
            partial_execution_targets(&json!({"partialExecutionTargets": ["missing"]}), &workflow)
                .unwrap_err();
        assert_eq!(error.code(), Some("COMFY_PARTIAL_TARGET_INVALID"));
    }

    #[test]
    fn upload_response_rejects_path_traversal_and_keeps_type() {
        let parsed = parse_input_ref(&json!({
            "name": "clip.mp4",
            "subfolder": "session",
            "type": "input"
        }))
        .unwrap();
        assert_eq!(parsed.workflow_value(), "session/clip.mp4");
        assert!(parse_input_ref(&json!({"name":"../secret.png"})).is_err());
    }

    #[tokio::test]
    async fn submits_polls_and_downloads_outputs() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut paths = Vec::new();
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut stream).await.unwrap();
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or_default()
                    .to_string();
                paths.push(path.clone());
                let (content_type, body) = if path == "/prompt" {
                    (
                        "application/json",
                        br#"{"prompt_id":"p1","number":0,"node_errors":{}}"#.to_vec(),
                    )
                } else if path == "/history/p1" {
                    (
                        "application/json",
                        br#"{"p1":{"status":{"status_str":"success"},"outputs":{"9":{"images":[{"filename":"result.png","subfolder":"","type":"output"}]}}}}"#.to_vec(),
                    )
                } else if path.starts_with("/view?") {
                    ("image/png", vec![137, 80, 78, 71, 13, 10, 26, 10])
                } else {
                    ("text/plain", b"not found".to_vec())
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
                stream.write_all(&body).await.unwrap();
            }
            paths
        });

        let profile = ComfyAdapterProfile::new("comfy-test", format!("http://{address}/"))
            .unwrap()
            .with_timeout(Duration::from_secs(5));
        let adapter = ComfyMediaAdapter::new(profile).unwrap();
        let job = adapter
            .submit(NormalizedMediaRequest {
                operation: MediaOperation::TextToImage,
                kind: MediaKind::Image,
                model: "workflow".to_string(),
                prompt: Some("test".to_string()),
                input_assets: Vec::new(),
                parameters: json!({
                    "workflow": {
                        "1": {"class_type": "SaveImage", "inputs": {}}
                    }
                }),
                client_request_id: Some("request-1".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(job.id, "p1");

        let status = adapter.poll_for_kind(&job, MediaKind::Image).await.unwrap();
        assert_eq!(status.status, MediaRunStatus::Succeeded);
        assert_eq!(status.outputs.len(), 1);

        let downloaded = adapter.download(&status.outputs[0]).await.unwrap();
        assert_eq!(downloaded.mime_type, "image/png");
        assert_eq!(downloaded.size_bytes, 8);
        assert!(!downloaded.sha256.is_empty());

        let paths = timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(paths[0], "/prompt");
        assert_eq!(paths[1], "/history/p1");
        assert!(paths[2].starts_with("/view?filename=result.png"));
    }

    #[tokio::test]
    async fn caches_object_info_and_uploads_controlled_input() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut paths = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut stream).await.unwrap();
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or_default()
                    .to_string();
                paths.push(path.clone());
                let (content_type, body) = if path == "/object_info" {
                    (
                        "application/json",
                        br#"{"SaveImage":{"input":{"required":{}}}}"#.to_vec(),
                    )
                } else if path == "/upload/image" {
                    (
                        "application/json",
                        br#"{"name":"reference.png","subfolder":"cc-panes","type":"input"}"#
                            .to_vec(),
                    )
                } else {
                    ("text/plain", b"not found".to_vec())
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
                stream.write_all(&body).await.unwrap();
            }
            paths
        });
        let profile =
            ComfyAdapterProfile::new("comfy-schema", format!("http://{address}/")).unwrap();
        let adapter = ComfyMediaAdapter::new(profile).unwrap();
        let (_, first_fingerprint) = adapter.object_info().await.unwrap();
        let (second, second_fingerprint) = adapter.object_info().await.unwrap();
        assert_eq!(first_fingerprint, second_fingerprint);
        assert!(second.get("SaveImage").is_some());
        let uploaded = adapter
            .upload_input("reference.png", "image/png", vec![1, 2, 3], false)
            .await
            .unwrap();
        assert_eq!(uploaded.workflow_value(), "cc-panes/reference.png");
        let paths = timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(paths, vec!["/object_info", "/upload/image"]);
    }

    #[tokio::test]
    async fn reads_system_stats_and_releases_memory_through_comfy_endpoints() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut paths = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut stream).await.unwrap();
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or_default()
                    .to_string();
                paths.push(path.clone());
                let (content_type, body) = if path == "/system_stats" {
                    (
                        "application/json",
                        br#"{"system":{"ram_total":100,"ram_free":40},"devices":[{"name":"GPU","vram_total":80,"vram_free":20}]}"#.to_vec(),
                    )
                } else {
                    ("application/json", b"{}".to_vec())
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
                stream.write_all(&body).await.unwrap();
            }
            paths
        });
        let profile =
            ComfyAdapterProfile::new("comfy-resources", format!("http://{address}/")).unwrap();
        let adapter = ComfyMediaAdapter::new(profile).unwrap();
        let stats = adapter.system_stats().await.unwrap();
        assert_eq!(stats.system.ram_free, Some(40));
        assert_eq!(stats.devices[0].vram_free, Some(20));
        adapter.free_memory(true, true).await.unwrap();
        let paths = timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(paths, vec!["/system_stats", "/free"]);
        let error = adapter.free_memory(false, false).await.unwrap_err();
        assert_eq!(error.code(), Some("COMFY_FREE_REQUEST_EMPTY"));
    }

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> Option<String> {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 2048];
        loop {
            let read = stream.read(&mut buffer).await.ok()?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..read]);
            if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
            if bytes.len() > 128 * 1024 {
                return None;
            }
        }
        String::from_utf8(bytes).ok()
    }
}
