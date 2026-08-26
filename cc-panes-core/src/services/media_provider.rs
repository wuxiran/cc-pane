//! Provider-neutral media generation adapters.
//!
//! The durable media service owns runs and assets. This module owns only the
//! provider boundary: normalizing requests, translating common OpenAI-style
//! responses, and downloading validated output bytes. No provider credential
//! is persisted or included in diagnostics.

use crate::models::{provider::Provider, MediaKind, MediaOperation, MediaRunStatus};
use crate::utils::error::{AppError, AppResult};
use base64::Engine;
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use url::Url;

const DEFAULT_IMAGE_SUBMIT_PATH: &str = "/images/generations";
const DEFAULT_VIDEO_SUBMIT_PATH: &str = "/videos/generations";
const DEFAULT_STATUS_PATH: &str = "/jobs/{job_id}";
const MAX_PROVIDER_ID_BYTES: usize = 128;
const MAX_MODEL_BYTES: usize = 256;
const MAX_PROMPT_BYTES: usize = 1024 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 128 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const PROVIDER_CONFIGURATION_FINGERPRINT_VERSION: &str = "media-provider-config-v1";

/// Wire protocol implemented by a provider adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaProtocol {
    OpenAiCompatible,
    Sub2Api,
    ComfyUi,
    Custom(String),
}

impl MediaProtocol {
    pub fn as_str(&self) -> &str {
        match self {
            Self::OpenAiCompatible => "open_ai_compatible",
            Self::Sub2Api => "sub2api",
            Self::ComfyUi => "comfyui",
            Self::Custom(value) => value.as_str(),
        }
    }
}

impl std::str::FromStr for MediaProtocol {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "open_ai_compatible" | "openai" | "openai_compatible" => Ok(Self::OpenAiCompatible),
            "sub2api" | "sub2_api" => Ok(Self::Sub2Api),
            "comfyui" | "comfy_ui" | "comfy" => Ok(Self::ComfyUi),
            other => Err(format!("unsupported media protocol: {other}")),
        }
    }
}

/// HTTP verb used by a provider cancellation endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum MediaHttpMethod {
    Post,
    Delete,
}

impl MediaHttpMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Post => "POST",
            Self::Delete => "DELETE",
        }
    }
}

/// Runtime-only provider configuration. `api_key` intentionally has no serde
/// implementation; callers should load it from the existing secret store and
/// drop it after the adapter is shut down.
#[derive(Clone)]
pub struct MediaProviderProfile {
    pub id: String,
    pub protocol: MediaProtocol,
    pub base_url: String,
    pub api_key: Option<String>,
    pub image_submit_path: String,
    pub video_submit_path: String,
    pub status_path_template: String,
    pub cancel_path_template: Option<String>,
    pub cancel_method: MediaHttpMethod,
    pub allowed_download_hosts: Vec<String>,
    pub request_timeout: Duration,
    pub max_download_bytes: u64,
    pub send_auth_to_download: bool,
}

impl fmt::Debug for MediaProviderProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MediaProviderProfile")
            .field("id", &self.id)
            .field("protocol", &self.protocol)
            .field("base_url", &redact_url_text(&self.base_url))
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("image_submit_path", &self.image_submit_path)
            .field("video_submit_path", &self.video_submit_path)
            .field("status_path_template", &self.status_path_template)
            .field("cancel_path_template", &self.cancel_path_template)
            .field("cancel_method", &self.cancel_method)
            .field("allowed_download_hosts", &self.allowed_download_hosts)
            .field("request_timeout", &self.request_timeout)
            .field("max_download_bytes", &self.max_download_bytes)
            .field("send_auth_to_download", &self.send_auth_to_download)
            .finish()
    }
}

impl MediaProviderProfile {
    pub fn new(
        id: impl Into<String>,
        base_url: impl Into<String>,
        api_key: Option<String>,
    ) -> AppResult<Self> {
        let base_url = normalize_base_url(&base_url.into())?;
        let base_host = Url::parse(&base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
            .ok_or_else(|| provider_config_error("provider base URL has no host"))?;
        let profile = Self {
            id: id.into(),
            protocol: MediaProtocol::OpenAiCompatible,
            base_url,
            api_key,
            image_submit_path: DEFAULT_IMAGE_SUBMIT_PATH.to_string(),
            video_submit_path: DEFAULT_VIDEO_SUBMIT_PATH.to_string(),
            status_path_template: DEFAULT_STATUS_PATH.to_string(),
            cancel_path_template: None,
            cancel_method: MediaHttpMethod::Post,
            allowed_download_hosts: vec![base_host],
            request_timeout: Duration::from_secs(120),
            max_download_bytes: DEFAULT_MAX_DOWNLOAD_BYTES,
            send_auth_to_download: false,
        };
        profile.validate()?;
        Ok(profile)
    }

    /// Build a runtime-only media profile from the existing ProviderService
    /// snapshot. Secrets stay in memory and are never serialized by this type.
    pub fn from_provider(provider: &Provider) -> AppResult<Self> {
        let base_url = provider.base_url.as_deref().ok_or_else(|| {
            AppError::coded(
                "MEDIA_PROVIDER_URL_REQUIRED",
                "provider has no base URL for media generation",
            )
        })?;
        Self::new(provider.id.clone(), base_url, provider.api_key.clone())
    }

    pub fn with_protocol(mut self, protocol: MediaProtocol) -> Self {
        self.protocol = protocol;
        self
    }

    pub fn with_submit_paths(
        mut self,
        image_path: impl Into<String>,
        video_path: impl Into<String>,
    ) -> Self {
        self.image_submit_path = image_path.into();
        self.video_submit_path = video_path.into();
        self
    }

    pub fn with_status_path(mut self, path_template: impl Into<String>) -> Self {
        self.status_path_template = path_template.into();
        self
    }

    pub fn with_cancel_path(
        mut self,
        path_template: impl Into<String>,
        method: MediaHttpMethod,
    ) -> Self {
        self.cancel_path_template = Some(path_template.into());
        self.cancel_method = method;
        self
    }

    pub fn with_allowed_download_hosts(mut self, hosts: Vec<String>) -> Self {
        self.allowed_download_hosts = hosts;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    pub fn with_max_download_bytes(mut self, max_bytes: u64) -> Self {
        self.max_download_bytes = max_bytes;
        self
    }

    /// Fingerprint the non-secret settings that choose a provider execution
    /// boundary. Transport-only download limits and credentials are excluded:
    /// they do not change generated content, and credentials must never enter
    /// persistent cache identity data.
    pub fn execution_config_fingerprint(&self) -> AppResult<String> {
        self.validate()?;
        crate::services::json_fingerprint(&serde_json::json!({
            "version": PROVIDER_CONFIGURATION_FINGERPRINT_VERSION,
            "providerId": self.id,
            "protocol": self.protocol.as_str(),
            "baseUrl": self.base_url,
            "imageSubmitPath": self.image_submit_path,
            "videoSubmitPath": self.video_submit_path,
            "statusPathTemplate": self.status_path_template,
            "cancelPathTemplate": self.cancel_path_template,
            "cancelMethod": self.cancel_method.as_str(),
        }))
    }

    pub fn validate(&self) -> AppResult<()> {
        validate_identifier(&self.id, "provider id", MAX_PROVIDER_ID_BYTES)?;
        let base = parse_provider_url(&self.base_url)?;
        validate_path(&self.image_submit_path, "image submit path", false)?;
        validate_path(&self.video_submit_path, "video submit path", false)?;
        validate_path(&self.status_path_template, "status path", true)?;
        if let Some(path) = &self.cancel_path_template {
            validate_path(path, "cancel path", true)?;
        }
        if self.allowed_download_hosts.is_empty() {
            return Err(provider_config_error("download host allowlist is empty"));
        }
        for host in &self.allowed_download_hosts {
            validate_host(host)?;
        }
        if self.request_timeout.is_zero() || self.request_timeout > MAX_TIMEOUT {
            return Err(provider_config_error("provider timeout is out of range"));
        }
        if self.max_download_bytes == 0 || self.max_download_bytes > DEFAULT_MAX_DOWNLOAD_BYTES {
            return Err(provider_config_error("download size limit is out of range"));
        }
        if base.username() != "" || base.password().is_some() {
            return Err(provider_config_error(
                "provider URL must not contain credentials",
            ));
        }
        if base.query().is_some() || base.fragment().is_some() || base.path().contains("..") {
            return Err(provider_config_error(
                "provider URL must not contain query, fragment or parent path components",
            ));
        }
        if self.api_key.as_deref().is_some_and(str::is_empty) {
            return Err(provider_config_error("provider API key must not be empty"));
        }
        Ok(())
    }

    fn submit_path(&self, kind: MediaKind) -> &str {
        match kind {
            MediaKind::Image => &self.image_submit_path,
            MediaKind::Video => &self.video_submit_path,
        }
    }
}

/// Apply the same node/request protocol precedence used by the worker before
/// calculating cache identity or constructing an adapter.
pub fn apply_media_run_protocol(
    profile: MediaProviderProfile,
    node_parameters: &Value,
    request: &Value,
) -> AppResult<MediaProviderProfile> {
    let node_protocol = node_parameters
        .get("providerProtocol")
        .and_then(|value| value.as_str());
    let run_protocol = request
        .get("parameters")
        .and_then(|value| value.get("providerProtocol"))
        .and_then(|value| value.as_str());
    let Some(raw) = node_protocol.or(run_protocol) else {
        return Ok(profile);
    };
    let protocol = raw
        .parse::<MediaProtocol>()
        .map_err(|message| AppError::coded("MEDIA_PROVIDER_PROTOCOL_INVALID", message))?;
    Ok(profile.with_protocol(protocol))
}

/// A normalized request independent of a provider's wire format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMediaRequest {
    pub operation: MediaOperation,
    pub kind: MediaKind,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default)]
    pub input_assets: Vec<MediaInputAsset>,
    #[serde(default)]
    pub parameters: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInputAsset {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

impl NormalizedMediaRequest {
    pub fn validate(&self) -> AppResult<()> {
        if !self.operation.supports_kind(self.kind) {
            return Err(AppError::coded(
                "MEDIA_OPERATION_KIND_MISMATCH",
                "media operation does not support this output kind",
            ));
        }
        validate_identifier(&self.model, "model", MAX_MODEL_BYTES)?;
        if let Some(prompt) = &self.prompt {
            if prompt.len() > MAX_PROMPT_BYTES {
                return Err(AppError::coded(
                    "MEDIA_PROMPT_TOO_LARGE",
                    "media prompt exceeds size limit",
                ));
            }
        }
        if self.input_assets.len() > 32 {
            return Err(AppError::coded(
                "MEDIA_INPUT_TOO_MANY",
                "too many media input assets",
            ));
        }
        if !self.parameters.is_null() && !self.parameters.is_object() {
            return Err(AppError::coded(
                "MEDIA_PARAMETERS_INVALID",
                "media parameters must be a JSON object",
            ));
        }
        for input in &self.input_assets {
            if input.url.is_some() == input.data.is_some() {
                return Err(AppError::coded(
                    "MEDIA_INPUT_INVALID",
                    "an input asset must contain exactly one URL or data value",
                ));
            }
            if let Some(mime) = &input.mime_type {
                validate_mime(mime, None)?;
            }
            if let Some(url) = &input.url {
                validate_input_url(url)?;
            }
            if let Some(data) = &input.data {
                if data.len() > 96 * 1024 * 1024 {
                    return Err(AppError::coded(
                        "MEDIA_INPUT_TOO_LARGE",
                        "inline media input exceeds the size limit",
                    ));
                }
            }
        }
        Ok(())
    }

    fn to_wire_body(&self) -> AppResult<Value> {
        self.validate()?;
        let mut body = self
            .parameters
            .as_object()
            .cloned()
            .unwrap_or_else(Map::new);
        body.insert("model".to_string(), Value::String(self.model.clone()));
        if let Some(prompt) = &self.prompt {
            body.insert("prompt".to_string(), Value::String(prompt.clone()));
        }
        if !self.input_assets.is_empty() {
            let inputs = self
                .input_assets
                .iter()
                .map(wire_input_value)
                .collect::<Vec<_>>();
            let masks = self
                .input_assets
                .iter()
                .filter(|input| input_role(input) == Some("mask"))
                .map(wire_input_value)
                .collect::<Vec<_>>();
            body.insert("input".to_string(), Value::Array(inputs));
            // Keep the provider-neutral `input` list for existing adapters,
            // while exposing the conventional image-edit field when a staged
            // asset explicitly carries the mask role. Providers that do not
            // use this field can ignore it and continue reading `input`.
            if !masks.is_empty() {
                body.insert(
                    "mask".to_string(),
                    if masks.len() == 1 {
                        masks.into_iter().next().unwrap_or(Value::Null)
                    } else {
                        Value::Array(masks)
                    },
                );
            }
        }
        let body = Value::Object(body);
        let body_size = serde_json::to_vec(&body)
            .map_err(|_| {
                AppError::coded(
                    "MEDIA_PARAMETERS_INVALID",
                    "media request is not serializable",
                )
            })?
            .len();
        if body_size > MAX_REQUEST_BODY_BYTES {
            return Err(AppError::coded(
                "MEDIA_REQUEST_TOO_LARGE",
                "media provider request exceeds the size limit",
            ));
        }
        Ok(body)
    }
}

fn input_role(input: &MediaInputAsset) -> Option<&str> {
    input
        .metadata
        .get("role")
        .or_else(|| input.metadata.get("assetRole"))
        .and_then(Value::as_str)
}

fn wire_input_value(input: &MediaInputAsset) -> Value {
    if let Some(url) = &input.url {
        return Value::String(url.clone());
    }
    let mut value = Map::new();
    value.insert(
        "data".to_string(),
        Value::String(input.data.clone().unwrap_or_default()),
    );
    if let Some(mime) = &input.mime_type {
        value.insert("mimeType".to_string(), Value::String(mime.clone()));
    }
    if let Some(role) = input_role(input) {
        value.insert("role".to_string(), Value::String(role.to_string()));
    }
    Value::Object(value)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteJobError {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOutput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b64_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MediaKind>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteJob {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel_url: Option<String>,
    pub status: MediaRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<i32>,
    #[serde(default)]
    pub outputs: Vec<RemoteOutput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteJobError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteJobStatus {
    pub id: String,
    pub status: MediaRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<i32>,
    #[serde(default)]
    pub outputs: Vec<RemoteOutput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteJobError>,
}

/// Backwards-friendly name for callers that refer to a poll result as a job
/// status rather than a remote status envelope.
pub type MediaJobStatus = RemoteJobStatus;

/// Downloaded bytes and safe metadata. The source URL is stripped of query
/// and fragment components before it is returned, so signed URL credentials
/// cannot accidentally be persisted or logged by a caller.
#[derive(Debug, Clone)]
pub struct DownloadedAsset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub filename: Option<String>,
    pub source_url: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProviderCapabilities {
    pub provider_id: String,
    pub protocol: MediaProtocol,
    pub kinds: Vec<MediaKind>,
    pub operations: Vec<MediaOperation>,
    pub supports_async_jobs: bool,
    pub supports_cancel: bool,
}

pub type MediaProviderFuture<'a, T> = Pin<Box<dyn Future<Output = AppResult<T>> + Send + 'a>>;

/// Provider adapter contract. Implementations may use any HTTP/API protocol;
/// the registry and job worker only depend on these normalized values.
pub trait MediaProviderAdapter: Send + Sync {
    fn provider_id(&self) -> &str;
    fn protocol(&self) -> MediaProtocol;
    fn capabilities(&self) -> MediaProviderCapabilities;
    fn submit<'a>(&'a self, request: NormalizedMediaRequest) -> MediaProviderFuture<'a, RemoteJob>;
    fn poll<'a>(&'a self, job: &'a RemoteJob) -> MediaProviderFuture<'a, RemoteJobStatus>;
    /// Poll with the durable node kind available.  The default keeps existing
    /// adapters source-compatible; HTTP adapters override it so a status
    /// response containing only a generic URL does not lose video/image type.
    fn poll_for_kind<'a>(
        &'a self,
        job: &'a RemoteJob,
        _kind: MediaKind,
    ) -> MediaProviderFuture<'a, RemoteJobStatus> {
        self.poll(job)
    }
    fn cancel<'a>(&'a self, job: &'a RemoteJob) -> MediaProviderFuture<'a, ()>;
    fn download<'a>(&'a self, output: &'a RemoteOutput)
        -> MediaProviderFuture<'a, DownloadedAsset>;
}

/// Thread-safe adapter registry used by the job worker and all frontends.
#[derive(Clone, Default)]
pub struct MediaProviderRegistry {
    adapters: Arc<RwLock<HashMap<String, Arc<dyn MediaProviderAdapter>>>>,
}

impl fmt::Debug for MediaProviderRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MediaProviderRegistry")
            .field("provider_ids", &self.provider_ids())
            .finish()
    }
}

impl MediaProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, adapter: Arc<dyn MediaProviderAdapter>) -> AppResult<()> {
        validate_identifier(adapter.provider_id(), "provider id", MAX_PROVIDER_ID_BYTES)?;
        let mut adapters = self
            .adapters
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if adapters.contains_key(adapter.provider_id()) {
            return Err(AppError::coded(
                "MEDIA_PROVIDER_DUPLICATE",
                "a media provider with this id is already registered",
            ));
        }
        adapters.insert(adapter.provider_id().to_string(), adapter);
        Ok(())
    }

    pub fn register_adapter<A>(&self, adapter: A) -> AppResult<()>
    where
        A: MediaProviderAdapter + 'static,
    {
        self.register(Arc::new(adapter))
    }

    /// Replace an adapter when a persisted Provider is edited. The worker can
    /// refresh credentials and endpoint paths without restarting the app.
    pub fn upsert(&self, adapter: Arc<dyn MediaProviderAdapter>) -> AppResult<()> {
        validate_identifier(adapter.provider_id(), "provider id", MAX_PROVIDER_ID_BYTES)?;
        self.adapters
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(adapter.provider_id().to_string(), adapter);
        Ok(())
    }

    pub fn remove(&self, provider_id: &str) -> Option<Arc<dyn MediaProviderAdapter>> {
        self.adapters
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(provider_id)
    }

    pub fn get(&self, provider_id: &str) -> Option<Arc<dyn MediaProviderAdapter>> {
        self.adapters
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(provider_id)
            .cloned()
    }

    pub fn require(&self, provider_id: &str) -> AppResult<Arc<dyn MediaProviderAdapter>> {
        self.get(provider_id).ok_or_else(|| {
            AppError::coded(
                "MEDIA_PROVIDER_NOT_FOUND",
                "media provider is not registered",
            )
        })
    }

    pub fn provider_ids(&self) -> Vec<String> {
        let mut ids: Vec<_> = self
            .adapters
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    pub fn capabilities(&self) -> Vec<MediaProviderCapabilities> {
        let mut capabilities: Vec<_> = self
            .adapters
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .map(|adapter| adapter.capabilities())
            .collect();
        capabilities.sort_by(|left, right| left.provider_id.cmp(&right.provider_id));
        capabilities
    }
}

/// Build the runtime registry from the existing ProviderService snapshot.
/// Invalid or non-media providers are skipped with a diagnostic so one bad
/// credential cannot prevent the desktop app from starting.
pub fn registry_from_providers(providers: Vec<Provider>) -> (MediaProviderRegistry, Vec<String>) {
    let registry = MediaProviderRegistry::new();
    let mut skipped = Vec::new();
    for provider in providers {
        let provider_id = provider.id.clone();
        let profile = match MediaProviderProfile::from_provider(&provider) {
            Ok(profile) => profile,
            Err(error) => {
                skipped.push(format!("{}: {}", provider_id, error.message()));
                continue;
            }
        };
        let adapter = match OpenAiCompatibleMediaAdapter::new(profile) {
            Ok(adapter) => adapter,
            Err(error) => {
                skipped.push(format!("{}: {}", provider_id, error.message()));
                continue;
            }
        };
        if let Err(error) = registry.register(Arc::new(adapter)) {
            skipped.push(format!("{}: {}", provider_id, error.message()));
        }
    }
    (registry, skipped)
}

/// Generic adapter for providers exposing OpenAI-style media endpoints.
#[derive(Clone)]
pub struct OpenAiCompatibleMediaAdapter {
    profile: Arc<MediaProviderProfile>,
    client: reqwest::Client,
    submitted_kinds: Arc<RwLock<HashMap<String, MediaKind>>>,
}

impl fmt::Debug for OpenAiCompatibleMediaAdapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiCompatibleMediaAdapter")
            .field("profile", &self.profile)
            .finish()
    }
}

impl OpenAiCompatibleMediaAdapter {
    pub fn new(profile: MediaProviderProfile) -> AppResult<Self> {
        profile.validate()?;
        if !matches!(
            profile.protocol,
            MediaProtocol::OpenAiCompatible | MediaProtocol::Sub2Api
        ) {
            return Err(provider_config_error(
                "media adapter requires a supported HTTP protocol",
            ));
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(profile.request_timeout)
            .build()
            .map_err(|_| provider_config_error("failed to create provider HTTP client"))?;
        Ok(Self {
            profile: Arc::new(profile),
            client,
            submitted_kinds: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// Inject a client in tests or in an application that owns proxy/TLS
    /// settings. The caller should configure redirects to `none`; response
    /// URLs are still validated before any media bytes are accepted.
    pub fn with_client(client: reqwest::Client, profile: MediaProviderProfile) -> AppResult<Self> {
        profile.validate()?;
        if !matches!(
            profile.protocol,
            MediaProtocol::OpenAiCompatible | MediaProtocol::Sub2Api
        ) {
            return Err(provider_config_error(
                "media adapter requires a supported HTTP protocol",
            ));
        }
        Ok(Self {
            profile: Arc::new(profile),
            client,
            submitted_kinds: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub fn profile(&self) -> &MediaProviderProfile {
        &self.profile
    }

    async fn submit_inner(&self, request: NormalizedMediaRequest) -> AppResult<RemoteJob> {
        let body = request.to_wire_body()?;
        let url = self.endpoint(self.profile.submit_path(request.kind), None)?;
        let mut builder = self.client.post(url).header(ACCEPT, "application/json");
        builder = self.apply_auth(builder)?;
        if let Some(request_id) = &request.client_request_id {
            let value = HeaderValue::from_str(request_id).map_err(|_| {
                AppError::coded(
                    "MEDIA_CLIENT_REQUEST_ID_INVALID",
                    "client request id cannot be used as an HTTP header",
                )
            })?;
            builder = builder.header("Idempotency-Key", value);
        }
        let response = builder
            .json(&body)
            .send()
            .await
            .map_err(http_transport_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(http_status_error(status.as_u16()));
        }
        let value = read_json(response).await?;
        let job = parse_submit_response_for_kind(&value, request.kind)?;
        self.submitted_kinds
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(job.id.clone(), request.kind);
        Ok(self.redact_job_error(job))
    }

    async fn poll_inner(&self, job: &RemoteJob) -> AppResult<RemoteJobStatus> {
        self.poll_inner_for_kind(job, None).await
    }

    async fn poll_inner_for_kind(
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
        let url = if let Some(status_url) = &job.status_url {
            self.remote_url(status_url)?
        } else {
            self.endpoint(&self.profile.status_path_template, Some(&job.id))?
        };
        let mut builder = self.client.get(url).header(ACCEPT, "application/json");
        builder = self.apply_auth(builder)?;
        let response = builder.send().await.map_err(http_transport_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(http_status_error(status.as_u16()));
        }
        let value = read_json(response).await?;
        let kind = expected_kind.or_else(|| {
            self.submitted_kinds
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(&job.id)
                .copied()
        });
        let mut parsed = match kind {
            Some(kind) => parse_status_response_for_kind(&value, &job.id, kind)?,
            None => parse_status_response(&value, &job.id)?,
        };
        if let Some(error) = parsed.error.as_mut() {
            error.message = self.redact_text(&error.message);
        }
        if parsed.status_url.is_none() {
            parsed.status_url = job.status_url.clone();
        }
        if parsed.cancel_url.is_none() {
            parsed.cancel_url = job.cancel_url.clone();
        }
        if parsed.status.is_terminal() {
            self.submitted_kinds
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&job.id);
        }
        Ok(parsed)
    }

    async fn cancel_inner(&self, job: &RemoteJob) -> AppResult<()> {
        if job.status.is_terminal() {
            return Ok(());
        }
        let (url, method) = if let Some(cancel_url) = &job.cancel_url {
            (self.remote_url(cancel_url)?, self.profile.cancel_method)
        } else if let Some(path) = &self.profile.cancel_path_template {
            (
                self.endpoint(path, Some(&job.id))?,
                self.profile.cancel_method,
            )
        } else {
            return Err(AppError::coded(
                "MEDIA_PROVIDER_CANCEL_UNSUPPORTED",
                "media provider does not expose cancellation",
            ));
        };
        let mut builder = match method {
            MediaHttpMethod::Post => self.client.post(url),
            MediaHttpMethod::Delete => self.client.delete(url),
        }
        .header(ACCEPT, "application/json");
        builder = self.apply_auth(builder)?;
        if method == MediaHttpMethod::Post {
            builder = builder.json(&Value::Object(Map::new()));
        }
        let response = builder.send().await.map_err(http_transport_error)?;
        if !response.status().is_success() {
            return Err(http_status_error(response.status().as_u16()));
        }
        self.submitted_kinds
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&job.id);
        Ok(())
    }

    async fn download_inner(&self, output: &RemoteOutput) -> AppResult<DownloadedAsset> {
        if output.url.is_some() && output.b64_json.is_some() {
            return Err(AppError::coded(
                "MEDIA_OUTPUT_INVALID",
                "provider output contains both URL and base64 data",
            ));
        }
        if let Some(encoded) = &output.b64_json {
            let (bytes, inline_mime) =
                decode_inline_data(encoded, self.profile.max_download_bytes)?;
            let mime = choose_mime(
                output.mime_type.as_deref(),
                inline_mime.as_deref(),
                output.kind,
                None,
            )?;
            return Ok(make_downloaded_asset(
                bytes,
                mime,
                output.filename.clone(),
                None,
                output.metadata.clone(),
            ));
        }
        let raw_url = output.url.as_deref().ok_or_else(|| {
            AppError::coded(
                "MEDIA_OUTPUT_INVALID",
                "provider output has no URL or base64 data",
            )
        })?;
        let url = self.download_url(raw_url)?;
        let safe_source_url = safe_url_without_query(&url);
        let mut builder = self.client.get(url.clone()).header(ACCEPT, "*/*");
        if self.profile.send_auth_to_download
            && url
                .host_str()
                .is_some_and(|host| self.is_allowed_host(host))
        {
            builder = self.apply_auth(builder)?;
        }
        let mut response = builder.send().await.map_err(http_transport_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(http_status_error(status.as_u16()));
        }
        let final_url = self.download_url(response.url().as_str())?;
        let declared_mime = output.mime_type.as_deref();
        let header_mime = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(normalize_mime);
        if let Some(length) = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
        {
            if length > self.profile.max_download_bytes {
                return Err(AppError::coded(
                    "MEDIA_DOWNLOAD_TOO_LARGE",
                    "provider output exceeds the configured size limit",
                ));
            }
        }
        // Do not use `response.bytes()` here: chunked responses have no
        // trustworthy Content-Length and could allocate unbounded memory before
        // the size check runs.  Accumulate only up to the configured cap.
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(http_transport_error)? {
            let next_size = bytes.len() as u64 + chunk.len() as u64;
            if next_size > self.profile.max_download_bytes {
                return Err(AppError::coded(
                    "MEDIA_DOWNLOAD_TOO_LARGE",
                    "provider output exceeds the configured size limit",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let mime = choose_mime(
            declared_mime,
            header_mime.as_deref(),
            output.kind,
            mime_from_url(&final_url),
        )?;
        Ok(make_downloaded_asset(
            bytes,
            mime,
            output.filename.clone(),
            Some(safe_source_url),
            output.metadata.clone(),
        ))
    }

    fn apply_auth(&self, builder: reqwest::RequestBuilder) -> AppResult<reqwest::RequestBuilder> {
        let Some(api_key) = self.profile.api_key.as_deref() else {
            return Ok(builder);
        };
        let value = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
            provider_config_error("provider API key contains invalid HTTP characters")
        })?;
        Ok(builder.header(AUTHORIZATION, value))
    }

    fn redact_job_error(&self, mut job: RemoteJob) -> RemoteJob {
        if let Some(error) = job.error.as_mut() {
            error.message = self.redact_text(&error.message);
        }
        job
    }

    fn redact_text(&self, value: &str) -> String {
        let redacted = self
            .profile
            .api_key
            .as_deref()
            .filter(|secret| !secret.is_empty())
            .map(|secret| value.replace(secret, "[REDACTED]"))
            .unwrap_or_else(|| value.to_string());
        truncate_text(&redacted)
    }

    fn endpoint(&self, path: &str, job_id: Option<&str>) -> AppResult<Url> {
        let path = if let Some(job_id) = job_id {
            path.replace("{job_id}", &urlencoding::encode(job_id))
        } else {
            path.to_string()
        };
        let base = Url::parse(&self.profile.base_url)
            .map_err(|_| provider_config_error("provider base URL is invalid"))?;
        let url = base
            .join(path.trim_start_matches('/'))
            .map_err(|_| provider_config_error("provider endpoint path is invalid"))?;
        self.remote_url(url.as_str())
    }

    fn remote_url(&self, raw_url: &str) -> AppResult<Url> {
        let url = Url::parse(raw_url).map_err(|_| {
            AppError::coded("MEDIA_PROVIDER_URL_INVALID", "provider URL is invalid")
        })?;
        if !is_secure_or_local_url(&url)
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(AppError::coded(
                "MEDIA_PROVIDER_URL_REJECTED",
                "provider URL must use HTTPS and a configured provider host",
            ));
        }
        let host = url.host_str().unwrap_or_default();
        if !self.is_allowed_host(host) {
            return Err(AppError::coded(
                "MEDIA_PROVIDER_URL_REJECTED",
                "provider URL host is not allowlisted",
            ));
        }
        Ok(url)
    }

    fn download_url(&self, raw_url: &str) -> AppResult<Url> {
        let url = self.remote_url(raw_url)?;
        if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
            return Err(AppError::coded(
                "MEDIA_PROVIDER_URL_REJECTED",
                "download URL contains unsafe components",
            ));
        }
        Ok(url)
    }

    fn is_allowed_host(&self, host: &str) -> bool {
        self.profile
            .allowed_download_hosts
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(host))
    }
}

impl MediaProviderAdapter for OpenAiCompatibleMediaAdapter {
    fn provider_id(&self) -> &str {
        &self.profile.id
    }

    fn protocol(&self) -> MediaProtocol {
        self.profile.protocol.clone()
    }

    fn capabilities(&self) -> MediaProviderCapabilities {
        MediaProviderCapabilities {
            provider_id: self.profile.id.clone(),
            protocol: self.profile.protocol.clone(),
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
            supports_cancel: self.profile.cancel_path_template.is_some(),
        }
    }

    fn submit<'a>(&'a self, request: NormalizedMediaRequest) -> MediaProviderFuture<'a, RemoteJob> {
        Box::pin(self.submit_inner(request))
    }

    fn poll<'a>(&'a self, job: &'a RemoteJob) -> MediaProviderFuture<'a, RemoteJobStatus> {
        Box::pin(self.poll_inner(job))
    }

    fn poll_for_kind<'a>(
        &'a self,
        job: &'a RemoteJob,
        kind: MediaKind,
    ) -> MediaProviderFuture<'a, RemoteJobStatus> {
        Box::pin(self.poll_inner_for_kind(job, Some(kind)))
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

/// Parse a successful OpenAI-style generation response without making a
/// network request. It accepts both synchronous `data` outputs and async job
/// envelopes (`id` + `status`/`output`).
pub fn parse_submit_response(value: &Value) -> AppResult<RemoteJob> {
    parse_submit_response_for_kind(value, MediaKind::Image)
}

pub fn parse_submit_response_for_kind(
    value: &Value,
    output_kind: MediaKind,
) -> AppResult<RemoteJob> {
    let id = string_field(value, &["id", "job_id", "jobId"]);
    let outputs = parse_outputs(value, output_kind);
    let raw_status = value.get("status").and_then(Value::as_str);
    let status = parse_status(
        raw_status,
        if raw_status.is_some() {
            MediaRunStatus::Processing
        } else if outputs.is_empty() {
            MediaRunStatus::Queued
        } else {
            MediaRunStatus::Succeeded
        },
    );
    let id = id.unwrap_or_else(|| "sync".to_string());
    validate_remote_job_id(&id)?;
    let error = parse_error(value);
    if status == MediaRunStatus::Queued && outputs.is_empty() && error.is_some() {
        return Err(AppError::coded(
            "MEDIA_PROVIDER_RESPONSE_INVALID",
            "provider returned an error without a usable job",
        ));
    }
    Ok(RemoteJob {
        id,
        status_url: string_field(value, &["status_url", "statusUrl", "poll_url", "pollUrl"]),
        cancel_url: string_field(value, &["cancel_url", "cancelUrl"]),
        status,
        progress: parse_progress(value.get("progress")),
        outputs,
        error,
    })
}

/// Parse a provider status response into the durable state vocabulary.
pub fn parse_status_response(value: &Value, fallback_id: &str) -> AppResult<RemoteJobStatus> {
    parse_status_response_for_kind(value, fallback_id, infer_output_kind(value))
}

/// Parse a status response when the durable node already tells us the output
/// kind.  Provider status payloads frequently contain only `url` and `status`;
/// inferring from the whole JSON is not reliable for an async MP4 job.
pub fn parse_status_response_for_kind(
    value: &Value,
    fallback_id: &str,
    output_kind: MediaKind,
) -> AppResult<RemoteJobStatus> {
    let id =
        string_field(value, &["id", "job_id", "jobId"]).unwrap_or_else(|| fallback_id.to_string());
    validate_remote_job_id(&id)?;
    let outputs = parse_outputs(value, output_kind);
    let raw_status = value.get("status").and_then(Value::as_str);
    let status = parse_status(
        raw_status,
        if outputs.is_empty() {
            MediaRunStatus::Processing
        } else {
            MediaRunStatus::Succeeded
        },
    );
    Ok(RemoteJobStatus {
        id,
        status,
        status_url: string_field(value, &["status_url", "statusUrl", "poll_url", "pollUrl"]),
        cancel_url: string_field(value, &["cancel_url", "cancelUrl"]),
        progress: parse_progress(value.get("progress")),
        outputs,
        error: parse_error(value),
    })
}

pub use parse_status_response as parse_openai_status_response;
pub use parse_submit_response as parse_openai_submit_response;
pub use parse_submit_response_for_kind as parse_openai_submit_response_for_kind;

fn parse_outputs(value: &Value, default_kind: MediaKind) -> Vec<RemoteOutput> {
    let source = value
        .get("data")
        .or_else(|| value.get("output"))
        .or_else(|| value.get("outputs"))
        .or_else(|| value.get("result"));
    let values: Vec<&Value> = match source {
        Some(Value::Array(values)) => values.iter().collect(),
        Some(value) => vec![value],
        None => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(|item| parse_output(item, default_kind))
        .collect()
}

fn parse_output(value: &Value, default_kind: MediaKind) -> Option<RemoteOutput> {
    if let Some(url) = value.as_str() {
        return Some(RemoteOutput {
            url: Some(url.to_string()),
            b64_json: None,
            mime_type: None,
            filename: None,
            kind: Some(default_kind),
            metadata: Value::Null,
        });
    }
    let object = value.as_object()?;
    let url = string_field(
        value,
        &[
            "url",
            "uri",
            "download_url",
            "downloadUrl",
            "video_url",
            "videoUrl",
            "image_url",
            "imageUrl",
        ],
    );
    let b64_json =
        string_field(value, &["b64_json", "b64Json", "base64", "data"]).filter(|_| url.is_none());
    if url.is_none() && b64_json.is_none() {
        return None;
    }
    let metadata = object.get("metadata").cloned().unwrap_or(Value::Null);
    Some(RemoteOutput {
        url,
        b64_json,
        mime_type: string_field(
            value,
            &["mime_type", "mimeType", "content_type", "contentType"],
        ),
        filename: string_field(value, &["filename", "file_name", "fileName"]),
        kind: Some(default_kind),
        metadata,
    })
}

fn parse_error(value: &Value) -> Option<RemoteJobError> {
    let error = value.get("error")?;
    if let Some(message) = error.as_str() {
        return Some(RemoteJobError {
            code: None,
            message: truncate_text(message),
        });
    }
    error.as_object()?;
    let message = string_field(error, &["message", "detail", "error"])?;
    Some(RemoteJobError {
        code: string_field(error, &["code", "type", "status"]),
        message: truncate_text(&message),
    })
}

fn parse_status(raw: Option<&str>, fallback: MediaRunStatus) -> MediaRunStatus {
    let normalized = raw.unwrap_or_default().to_ascii_lowercase();
    match normalized.as_str() {
        "queued" | "pending" | "submitted" | "created" => MediaRunStatus::Queued,
        "submitting" => MediaRunStatus::Submitting,
        "processing" | "running" | "in_progress" | "in-progress" => MediaRunStatus::Processing,
        "downloading" => MediaRunStatus::Downloading,
        "canceling" | "cancelling" | "cancel_requested" => MediaRunStatus::Canceling,
        "succeeded" | "success" | "completed" | "complete" | "done" => MediaRunStatus::Succeeded,
        "failed" | "failure" | "error" => MediaRunStatus::Failed,
        "canceled" | "cancelled" => MediaRunStatus::Canceled,
        _ => fallback,
    }
}

fn parse_progress(value: Option<&Value>) -> Option<i32> {
    let number = value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str()?.parse::<f64>().ok())
    })?;
    if !number.is_finite() {
        return None;
    }
    Some(number.round().clamp(0.0, 100.0) as i32)
}

fn infer_output_kind(value: &Value) -> MediaKind {
    let text = serde_json::to_string(value)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if text.contains("video")
        || text.contains("mp4")
        || text.contains("webm")
        || text.contains("mkv")
        || text.contains("matroska")
    {
        MediaKind::Video
    } else {
        MediaKind::Image
    }
}

fn string_field(value: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        value
            .get(*name)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    })
}

fn validate_remote_job_id(value: &str) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(AppError::coded(
            "MEDIA_PROVIDER_RESPONSE_INVALID",
            "provider returned an invalid job id",
        ));
    }
    Ok(())
}

async fn read_json(response: reqwest::Response) -> AppResult<Value> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_RESPONSE_BYTES)
    {
        return Err(AppError::coded(
            "MEDIA_PROVIDER_RESPONSE_TOO_LARGE",
            "provider response exceeds the JSON size limit",
        ));
    }
    let bytes = response.bytes().await.map_err(http_transport_error)?;
    if bytes.len() as u64 > MAX_JSON_RESPONSE_BYTES {
        return Err(AppError::coded(
            "MEDIA_PROVIDER_RESPONSE_TOO_LARGE",
            "provider response exceeds the JSON size limit",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        AppError::coded(
            "MEDIA_PROVIDER_RESPONSE_INVALID",
            "provider returned invalid JSON",
        )
    })
}

fn decode_inline_data(value: &str, max_bytes: u64) -> AppResult<(Vec<u8>, Option<String>)> {
    let (payload, mime) = if let Some((header, payload)) = value.split_once(",") {
        if !header.starts_with("data:") || !header.to_ascii_lowercase().contains(";base64") {
            return Err(AppError::coded(
                "MEDIA_OUTPUT_INVALID",
                "inline provider output is not base64 data",
            ));
        }
        (
            payload,
            header
                .strip_prefix("data:")
                .and_then(|header| header.split(';').next())
                .map(str::to_string),
        )
    } else {
        (value, None)
    };
    if payload.len() as u64 > max_bytes.saturating_mul(2) {
        return Err(AppError::coded(
            "MEDIA_DOWNLOAD_TOO_LARGE",
            "provider output exceeds the configured size limit",
        ));
    }
    type Base64Decoder = fn(&str) -> Result<Vec<u8>, base64::DecodeError>;
    fn decode_standard(input: &str) -> Result<Vec<u8>, base64::DecodeError> {
        base64::engine::general_purpose::STANDARD.decode(input)
    }
    fn decode_standard_no_pad(input: &str) -> Result<Vec<u8>, base64::DecodeError> {
        base64::engine::general_purpose::STANDARD_NO_PAD.decode(input)
    }
    fn decode_url_safe(input: &str) -> Result<Vec<u8>, base64::DecodeError> {
        base64::engine::general_purpose::URL_SAFE.decode(input)
    }
    fn decode_url_safe_no_pad(input: &str) -> Result<Vec<u8>, base64::DecodeError> {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(input)
    }
    let engines: [Base64Decoder; 4] = [
        decode_standard,
        decode_standard_no_pad,
        decode_url_safe,
        decode_url_safe_no_pad,
    ];
    let bytes = engines
        .iter()
        .find_map(|engine| engine(payload).ok())
        .ok_or_else(|| {
            AppError::coded("MEDIA_OUTPUT_INVALID", "provider base64 output is invalid")
        })?;
    if bytes.len() as u64 > max_bytes {
        return Err(AppError::coded(
            "MEDIA_DOWNLOAD_TOO_LARGE",
            "provider output exceeds the configured size limit",
        ));
    }
    Ok((bytes, mime))
}

fn choose_mime(
    declared: Option<&str>,
    header: Option<&str>,
    kind: Option<MediaKind>,
    extension: Option<String>,
) -> AppResult<String> {
    for candidate in [declared, header, extension.as_deref()] {
        if let Some(candidate) = candidate.and_then(normalize_mime) {
            if mime_matches_kind(&candidate, kind) && is_safe_media_mime(&candidate) {
                return Ok(candidate);
            }
        }
    }
    Err(AppError::coded(
        "MEDIA_MIME_INVALID",
        "provider output did not provide a supported image or video MIME type",
    ))
}

fn is_safe_media_mime(mime: &str) -> bool {
    mime != "image/svg+xml" && mime != "image/svg"
}

fn make_downloaded_asset(
    bytes: Vec<u8>,
    mime_type: String,
    filename: Option<String>,
    source_url: Option<String>,
    metadata: Value,
) -> DownloadedAsset {
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha256 = format!("{:x}", hasher.finalize());
    DownloadedAsset {
        size_bytes: bytes.len() as u64,
        bytes,
        mime_type,
        sha256,
        filename: filename.and_then(sanitize_filename),
        source_url,
        metadata,
    }
}

fn validate_mime(value: &str, kind: Option<MediaKind>) -> AppResult<()> {
    let mime = normalize_mime(value)
        .ok_or_else(|| AppError::coded("MEDIA_MIME_INVALID", "media MIME type is invalid"))?;
    if !mime_matches_kind(&mime, kind) {
        return Err(AppError::coded(
            "MEDIA_MIME_INVALID",
            "media MIME type does not match the requested kind",
        ));
    }
    Ok(())
}

fn normalize_mime(value: &str) -> Option<String> {
    let mime = value.split(';').next()?.trim().to_ascii_lowercase();
    if mime.len() > 128 || !mime.contains('/') || mime.chars().any(char::is_control) {
        return None;
    }
    Some(mime)
}

fn mime_matches_kind(mime: &str, kind: Option<MediaKind>) -> bool {
    match kind {
        Some(MediaKind::Image) => mime.starts_with("image/"),
        Some(MediaKind::Video) => mime.starts_with("video/"),
        None => mime.starts_with("image/") || mime.starts_with("video/"),
    }
}

fn mime_from_url(url: &Url) -> Option<String> {
    let extension = url.path().rsplit('.').next()?.to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "mp4" => "video/mp4",
        "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        _ => return None,
    };
    Some(mime.to_string())
}

fn sanitize_filename(value: String) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 255
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains(':')
    {
        return None;
    }
    Some(value.to_string())
}

fn normalize_base_url(value: &str) -> AppResult<String> {
    let mut url = parse_provider_url(value)?;
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url.to_string())
}

fn parse_provider_url(value: &str) -> AppResult<Url> {
    let url =
        Url::parse(value).map_err(|_| provider_config_error("provider base URL is invalid"))?;
    if !is_secure_or_local_url(&url) || url.host_str().is_none() {
        return Err(provider_config_error(
            "provider base URL must use HTTPS and contain a host",
        ));
    }
    Ok(url)
}

fn validate_input_url(value: &str) -> AppResult<()> {
    let url = Url::parse(value)
        .map_err(|_| AppError::coded("MEDIA_INPUT_URL_INVALID", "media input URL is invalid"))?;
    if !is_secure_or_local_url(&url)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || value.len() > 4096
    {
        return Err(AppError::coded(
            "MEDIA_INPUT_URL_REJECTED",
            "media input URL must be HTTPS (or loopback HTTP) without credentials",
        ));
    }
    Ok(())
}

fn validate_path(value: &str, field: &str, allow_job_id: bool) -> AppResult<()> {
    if value.is_empty()
        || !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('?')
        || value.contains('#')
        || value.contains("..")
        || value.to_ascii_lowercase().contains("%2e")
        || value.contains('\\')
        || (!allow_job_id && value.contains('{'))
        || (allow_job_id
            && value
                .replace("{job_id}", "")
                .chars()
                .any(|character| character == '{' || character == '}'))
    {
        return Err(provider_config_error(format!("{field} is invalid")));
    }
    Ok(())
}

fn validate_host(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 253
        || value.contains('/')
        || value.contains(':')
        || value.contains('*')
        || value.chars().any(char::is_whitespace)
    {
        return Err(provider_config_error("download host is invalid"));
    }
    Ok(())
}

fn validate_identifier(value: &str, field: &str, max_bytes: usize) -> AppResult<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.len() > max_bytes
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(provider_config_error(format!("{field} is invalid")));
    }
    Ok(())
}

fn is_secure_or_local_url(url: &Url) -> bool {
    if url.scheme().eq_ignore_ascii_case("https") {
        return true;
    }
    if !url.scheme().eq_ignore_ascii_case("http") {
        return false;
    }
    url.host_str().is_some_and(is_loopback_host)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn safe_url_without_query(url: &Url) -> String {
    let mut safe = url.clone();
    safe.set_query(None);
    safe.set_fragment(None);
    safe.to_string()
}

fn redact_url_text(value: &str) -> String {
    Url::parse(value)
        .map(|url| safe_url_without_query(&url))
        .unwrap_or_else(|_| "[invalid-url]".to_string())
}

fn truncate_text(value: &str) -> String {
    value.chars().take(1024).collect()
}

fn provider_config_error(message: impl Into<String>) -> AppError {
    AppError::coded("MEDIA_PROVIDER_CONFIG_INVALID", message)
}

fn http_transport_error(_: reqwest::Error) -> AppError {
    AppError::coded("MEDIA_PROVIDER_NETWORK", "media provider request failed")
}

fn http_status_error(status: u16) -> AppError {
    AppError::coded(
        "MEDIA_PROVIDER_HTTP",
        format!("media provider returned HTTP status {status}"),
    )
}

#[cfg(test)]
#[path = "media_provider_tests.rs"]
mod tests;
