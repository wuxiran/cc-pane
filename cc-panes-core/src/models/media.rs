//! Durable media-generation domain types shared by desktop and web runtimes.
//!
//! The core deliberately stops at a provider-neutral request/job model. Provider
//! HTTP adapters belong to the application layer; these types are safe to persist
//! and transport over the existing Tauri/Web boundaries.

use serde::{Deserialize, Serialize};
use std::fmt;

/// The kind of media rendered by a canvas node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Video,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
        }
    }
}

impl std::fmt::Display for MediaKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for MediaKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "image" => Ok(Self::Image),
            "video" => Ok(Self::Video),
            other => Err(format!("Invalid MediaKind: {other}")),
        }
    }
}

/// Operations exposed by the first media canvas slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaOperation {
    TextToImage,
    ImageToImage,
    TextToVideo,
    ImageToVideo,
    Edit,
    Upscale,
    Extend,
}

impl MediaOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TextToImage => "text_to_image",
            Self::ImageToImage => "image_to_image",
            Self::TextToVideo => "text_to_video",
            Self::ImageToVideo => "image_to_video",
            Self::Edit => "edit",
            Self::Upscale => "upscale",
            Self::Extend => "extend",
        }
    }

    /// Whether this operation can produce the given media kind.
    pub fn output_kind(self) -> MediaKind {
        match self {
            Self::TextToImage | Self::ImageToImage | Self::Edit | Self::Upscale => MediaKind::Image,
            Self::TextToVideo | Self::ImageToVideo | Self::Extend => MediaKind::Video,
        }
    }

    /// Operations such as edit/upscale/extend are valid for either media kind;
    /// their concrete output kind is determined by the node and input asset.
    pub fn supports_kind(self, kind: MediaKind) -> bool {
        match self {
            Self::TextToImage | Self::ImageToImage => kind == MediaKind::Image,
            Self::TextToVideo | Self::ImageToVideo => kind == MediaKind::Video,
            Self::Edit | Self::Upscale | Self::Extend => {
                let _ = kind;
                true
            }
        }
    }

    pub fn requires_input_asset(self) -> bool {
        matches!(
            self,
            Self::ImageToImage | Self::ImageToVideo | Self::Edit | Self::Upscale | Self::Extend
        )
    }
}

impl std::fmt::Display for MediaOperation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for MediaOperation {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "text_to_image" | "textToImage" => Ok(Self::TextToImage),
            "image_to_image" | "imageToImage" => Ok(Self::ImageToImage),
            "text_to_video" | "textToVideo" => Ok(Self::TextToVideo),
            "image_to_video" | "imageToVideo" => Ok(Self::ImageToVideo),
            "edit" => Ok(Self::Edit),
            "upscale" => Ok(Self::Upscale),
            "extend" => Ok(Self::Extend),
            other => Err(format!("Invalid MediaOperation: {other}")),
        }
    }
}

/// Durable lifecycle state of one provider job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaRunStatus {
    Queued,
    Submitting,
    Processing,
    Downloading,
    Canceling,
    Succeeded,
    Failed,
    Canceled,
}

impl MediaRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Submitting => "submitting",
            Self::Processing => "processing",
            Self::Downloading => "downloading",
            Self::Canceling => "canceling",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Canceled)
    }

    /// Basic local state-machine validation. Provider-specific transitions are
    /// intentionally handled by the caller, but no backwards transitions are
    /// accepted here.
    pub fn can_transition_to(self, next: Self) -> bool {
        if self == next {
            return true;
        }
        match self {
            Self::Queued => matches!(next, Self::Submitting | Self::Canceling | Self::Canceled),
            Self::Submitting => matches!(next, Self::Processing | Self::Failed | Self::Canceling),
            Self::Processing => {
                matches!(next, Self::Downloading | Self::Failed | Self::Canceling)
            }
            Self::Downloading => matches!(next, Self::Succeeded | Self::Failed | Self::Canceling),
            Self::Canceling => matches!(next, Self::Canceled | Self::Failed),
            Self::Succeeded | Self::Failed | Self::Canceled => false,
        }
    }
}

impl std::fmt::Display for MediaRunStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for MediaRunStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "submitting" => Ok(Self::Submitting),
            "processing" => Ok(Self::Processing),
            "downloading" => Ok(Self::Downloading),
            "canceling" | "cancelling" => Ok(Self::Canceling),
            "succeeded" | "success" => Ok(Self::Succeeded),
            "failed" | "error" => Ok(Self::Failed),
            "canceled" | "cancelled" => Ok(Self::Canceled),
            other => Err(format!("Invalid MediaRunStatus: {other}")),
        }
    }
}

/// Controls whether a media submission may read/write the execution cache.
/// `ReadWrite` is the default and preserves the normal generation workflow;
/// `Bypass` is useful for deliberate fresh samples while `Refresh` skips a
/// lookup but refreshes the cache entry after a successful run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MediaCachePolicy {
    #[default]
    ReadWrite,
    Bypass,
    Refresh,
}

impl MediaCachePolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadWrite => "read_write",
            Self::Bypass => "bypass",
            Self::Refresh => "refresh",
        }
    }

    pub fn allows_lookup(self) -> bool {
        matches!(self, Self::ReadWrite)
    }

    pub fn allows_write(self) -> bool {
        !matches!(self, Self::Bypass)
    }
}

impl std::str::FromStr for MediaCachePolicy {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "read_write" | "readWrite" => Ok(Self::ReadWrite),
            "bypass" => Ok(Self::Bypass),
            "refresh" => Ok(Self::Refresh),
            other => Err(format!("Invalid MediaCachePolicy: {other}")),
        }
    }
}

/// Persisted queue and cache counters exposed to the media studio.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaQueueSnapshot {
    pub queued: i64,
    pub active: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub canceled: i64,
    pub highest_priority: Option<i32>,
    pub oldest_queued_at: Option<String>,
    pub sampled_at: String,
}

/// Host resources sampled by the media scheduler. GPU fields remain optional
/// because ComfyUI may be backed by a remote runtime or a non-NVIDIA device.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaResourceSnapshot {
    pub cpu_percent: f32,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub free_memory_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_free_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_total_bytes: Option<u64>,
    pub sampled_at: String,
}

/// Combined queue/resource view used by desktop and web clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaSchedulerSnapshot {
    pub queue: MediaQueueSnapshot,
    pub active_workers: usize,
    pub max_concurrent: usize,
    pub owner: String,
    pub resource: MediaResourceSnapshot,
}

/// Provider/model identity stored on a node and copied to each run snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProviderRef {
    pub provider_id: String,
    pub model_id: String,
}

/// A media node projected onto a canvas layout.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaNode {
    pub id: String,
    pub workspace_id: String,
    pub layout_id: String,
    pub kind: MediaKind,
    pub title: String,
    pub default_operation: MediaOperation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_ref: Option<MediaProviderRef>,
    #[serde(default)]
    pub parameters: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMediaNodeRequest {
    pub workspace_id: String,
    pub layout_id: String,
    pub kind: MediaKind,
    pub title: String,
    #[serde(default)]
    pub default_operation: Option<MediaOperation>,
    #[serde(default)]
    pub provider_ref: Option<MediaProviderRef>,
    #[serde(default)]
    pub parameters: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMediaNodeRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default_operation: Option<MediaOperation>,
    #[serde(default)]
    pub provider_ref: Option<MediaProviderRef>,
    #[serde(default)]
    pub parameters: Option<serde_json::Value>,
}

/// One execution attempt. Inputs/outputs are denormalized in the API and
/// normalized in `media_run_assets` for efficient queries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaRun {
    pub id: String,
    pub node_id: String,
    pub operation: MediaOperation,
    pub status: MediaRunStatus,
    pub attempt: i32,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub cache_policy: MediaCachePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_ref: Option<MediaProviderRef>,
    #[serde(default)]
    pub request: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_fingerprint: Option<String>,
    #[serde(default)]
    pub cache_hit: bool,
    #[serde(default)]
    pub input_asset_ids: Vec<String>,
    #[serde(default)]
    pub output_asset_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMediaRunRequest {
    pub node_id: String,
    pub operation: MediaOperation,
    #[serde(default)]
    pub request: serde_json::Value,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub input_asset_ids: Vec<String>,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub cache_policy: Option<MediaCachePolicy>,
}

/// Create a new run from a historical run while allowing a small, explicit
/// set of overrides.  The source run remains immutable; this request is the
/// durable "variant"/"replay" boundary used by the Canvas history UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMediaRunRequest {
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub parameters: Option<serde_json::Value>,
    #[serde(default)]
    pub input_asset_ids: Option<Vec<String>>,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub cache_policy: Option<MediaCachePolicy>,
    #[serde(default)]
    pub client_request_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMediaRunRequest {
    #[serde(default)]
    pub status: Option<MediaRunStatus>,
    #[serde(default)]
    pub attempt: Option<i32>,
    #[serde(default)]
    pub priority: Option<i32>,
    /// `Some(None)` explicitly clears the nullable column.
    #[serde(default)]
    pub progress: Option<Option<i32>>,
    #[serde(default)]
    pub remote_job_id: Option<Option<String>>,
    #[serde(default)]
    pub error_code: Option<Option<String>>,
    #[serde(default)]
    pub error_message: Option<Option<String>>,
    #[serde(default)]
    pub lease_owner: Option<Option<String>>,
    #[serde(default)]
    pub lease_expires_at: Option<Option<String>>,
}

/// A provider-neutral request passed to a media adapter.
///
/// The run and asset metadata are snapshots. Adapters must not mutate them or
/// use them as authorization boundaries; the caller has already validated the
/// workspace and input ownership before constructing this value.
#[derive(Debug, Clone)]
pub struct MediaProviderRequest {
    pub run: MediaRun,
    pub node: MediaNode,
    pub input_assets: Vec<MediaAsset>,
}

#[derive(Debug, Clone)]
pub struct MediaProviderSubmission {
    pub remote_job_id: String,
    pub progress: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaProviderPollState {
    Processing,
    Succeeded,
    Failed,
    Canceled,
}

#[derive(Debug, Clone)]
pub struct MediaProviderPoll {
    pub state: MediaProviderPollState,
    pub progress: Option<i32>,
    pub outputs: Vec<MediaProviderOutput>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MediaProviderOutput {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub extension: Option<String>,
    pub sha256: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct MediaProviderError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl MediaProviderError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }
}

impl fmt::Display for MediaProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for MediaProviderError {}

/// Alias used by callers that treat a run as a job submission.
pub type MediaJobRequest = CreateMediaRunRequest;

/// A file persisted in the application media store.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub relative_path: String,
    pub mime_type: String,
    pub size_bytes: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub metadata: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMediaAssetRequest {
    pub workspace_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    pub relative_path: String,
    pub mime_type: String,
    pub size_bytes: i64,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// Request for staging a user-selected reference image/video into the
/// controlled media directory before a generation run consumes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageMediaInputRequest {
    pub workspace_id: String,
    pub filename: String,
    pub mime_type: String,
    /// Standard base64 payload without a data-URL prefix.
    pub data: String,
    /// Optional semantic role used by image editing workflows (for example,
    /// `mask`). The service validates and normalizes this metadata before it
    /// is persisted with the staged asset.
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// How a data edge selects an upstream output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaEdgeSelector {
    LatestSucceeded,
    SpecificAsset,
}

impl MediaEdgeSelector {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LatestSucceeded => "latest_succeeded",
            Self::SpecificAsset => "specific_asset",
        }
    }
}

impl std::str::FromStr for MediaEdgeSelector {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "latest_succeeded" | "latestSucceeded" => Ok(Self::LatestSucceeded),
            "specific_asset" | "specificAsset" => Ok(Self::SpecificAsset),
            other => Err(format!("Invalid MediaEdgeSelector: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaEdge {
    pub id: String,
    pub workspace_id: String,
    pub layout_id: String,
    pub source_node_id: String,
    pub source_port: String,
    pub target_node_id: String,
    pub target_port: String,
    pub selector: MediaEdgeSelector,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMediaEdgeRequest {
    pub workspace_id: String,
    pub layout_id: String,
    pub source_node_id: String,
    pub source_port: String,
    pub target_node_id: String,
    pub target_port: String,
    #[serde(default)]
    pub selector: Option<MediaEdgeSelector>,
    #[serde(default)]
    pub asset_id: Option<String>,
}
