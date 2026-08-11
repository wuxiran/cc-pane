use crate::utils::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

pub const TASK_QUEUE_MAX_ITEMS: usize = 100;
pub const TASK_QUEUE_MAX_TEXT_BYTES: usize = 65_536;
pub const TASK_QUEUE_MAX_IMAGE_REFS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskQueueState {
    Disabled,
    Running,
    Paused,
    ConfirmingIdle,
    Dispatching,
    ActionRequired,
    SendFailed,
    SessionEnded,
}

impl TaskQueueState {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::ConfirmingIdle => "confirming_idle",
            Self::Dispatching => "dispatching",
            Self::ActionRequired => "action_required",
            Self::SendFailed => "send_failed",
            Self::SessionEnded => "session_ended",
        }
    }

    pub fn from_db_str(value: &str) -> AppResult<Self> {
        match value {
            "disabled" => Ok(Self::Disabled),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "confirming_idle" => Ok(Self::ConfirmingIdle),
            "dispatching" => Ok(Self::Dispatching),
            "action_required" => Ok(Self::ActionRequired),
            "send_failed" => Ok(Self::SendFailed),
            "session_ended" => Ok(Self::SessionEnded),
            _ => Err(AppError::coded(
                "QUEUE_ROW_INVALID",
                format!("Invalid task queue state: {value}"),
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskQueueReason {
    GlobalDisabled,
    UserPaused,
    WaitingInput,
    UnknownPrompt,
    UnattendedUnsupported,
    AutomaticWriteUnavailable,
    SessionClaimLost,
    SessionError,
    SessionExited,
    DeliveryUnknown,
    SubmitFailed,
}

impl TaskQueueReason {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::GlobalDisabled => "global_disabled",
            Self::UserPaused => "user_paused",
            Self::WaitingInput => "waiting_input",
            Self::UnknownPrompt => "unknown_prompt",
            Self::UnattendedUnsupported => "unattended_unsupported",
            Self::AutomaticWriteUnavailable => "automatic_write_unavailable",
            Self::SessionClaimLost => "session_claim_lost",
            Self::SessionError => "session_error",
            Self::SessionExited => "session_exited",
            Self::DeliveryUnknown => "delivery_unknown",
            Self::SubmitFailed => "submit_failed",
        }
    }

    pub fn from_db_str(value: &str) -> AppResult<Self> {
        match value {
            "global_disabled" => Ok(Self::GlobalDisabled),
            "user_paused" => Ok(Self::UserPaused),
            "waiting_input" => Ok(Self::WaitingInput),
            "unknown_prompt" => Ok(Self::UnknownPrompt),
            "unattended_unsupported" => Ok(Self::UnattendedUnsupported),
            "automatic_write_unavailable" => Ok(Self::AutomaticWriteUnavailable),
            "session_claim_lost" => Ok(Self::SessionClaimLost),
            "session_error" => Ok(Self::SessionError),
            "session_exited" => Ok(Self::SessionExited),
            "delivery_unknown" => Ok(Self::DeliveryUnknown),
            "submit_failed" => Ok(Self::SubmitFailed),
            _ => Err(AppError::coded(
                "QUEUE_ROW_INVALID",
                format!("Invalid task queue reason: {value}"),
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueueItemState {
    Queued,
    Dispatching,
    Failed,
    DeliveryUnknown,
}

impl QueueItemState {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Dispatching => "dispatching",
            Self::Failed => "failed",
            Self::DeliveryUnknown => "delivery_unknown",
        }
    }

    pub fn from_db_str(value: &str) -> AppResult<Self> {
        match value {
            "queued" => Ok(Self::Queued),
            "dispatching" => Ok(Self::Dispatching),
            "failed" => Ok(Self::Failed),
            "delivery_unknown" => Ok(Self::DeliveryUnknown),
            _ => Err(AppError::coded(
                "QUEUE_ROW_INVALID",
                format!("Invalid task queue item state: {value}"),
            )),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueueItemDraft {
    pub text: String,
    #[serde(default)]
    pub image_refs: Vec<String>,
}

impl TaskQueueItemDraft {
    pub fn new(text: impl Into<String>, image_refs: Vec<String>) -> AppResult<Self> {
        let draft = Self {
            text: text.into(),
            image_refs,
        };
        draft.validated()
    }

    pub fn validated(&self) -> AppResult<Self> {
        let text = self.text.trim().to_string();
        if text.is_empty() && self.image_refs.is_empty() {
            return Err(AppError::coded(
                "QUEUE_ITEM_INVALID",
                "A queued task must contain text or an image",
            ));
        }
        if text.len() > TASK_QUEUE_MAX_TEXT_BYTES {
            return Err(AppError::coded(
                "QUEUE_ITEM_INVALID",
                format!("Queued task text exceeds {TASK_QUEUE_MAX_TEXT_BYTES} UTF-8 bytes"),
            ));
        }
        if self.image_refs.len() > TASK_QUEUE_MAX_IMAGE_REFS {
            return Err(AppError::coded(
                "QUEUE_ITEM_INVALID",
                format!("A queued task accepts at most {TASK_QUEUE_MAX_IMAGE_REFS} images"),
            ));
        }
        if self.image_refs.iter().any(|value| value.trim().is_empty()) {
            return Err(AppError::coded(
                "IMAGE_REF_INVALID",
                "Image references must not be empty",
            ));
        }
        Ok(Self {
            text,
            image_refs: self.image_refs.clone(),
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueueControlPatch {
    pub paused: Option<bool>,
    pub unattended: Option<bool>,
}

impl TaskQueueControlPatch {
    pub fn validate(&self) -> AppResult<()> {
        if self.paused.is_none() && self.unattended.is_none() {
            return Err(AppError::coded(
                "QUEUE_ITEM_INVALID",
                "Task queue control patch is empty",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueueItem {
    pub id: String,
    pub session_id: String,
    pub position: i64,
    pub text: String,
    pub image_refs: Vec<String>,
    pub state: QueueItemState,
    pub created_at: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueueSnapshot {
    pub session_id: String,
    pub paused: bool,
    pub unattended: bool,
    pub unattended_supported: bool,
    pub state: TaskQueueState,
    pub reason: Option<TaskQueueReason>,
    pub items: Vec<TaskQueueItem>,
    pub revision: i64,
    pub updated_at: i64,
}

impl TaskQueueSnapshot {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            paused: false,
            unattended: false,
            unattended_supported: false,
            state: TaskQueueState::Running,
            reason: None,
            items: Vec::new(),
            revision: 0,
            updated_at: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueueRuntime {
    pub enabled: bool,
    pub dispatch_generation: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskQueueClaim {
    pub token: String,
    pub dispatch_generation: i64,
    pub item: TaskQueueItem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedTaskQueueImage {
    pub image_ref: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecisionStatus {
    Inserted,
    Existing,
    FingerprintMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionDecisionRecord {
    pub status: PermissionDecisionStatus,
    pub decision: Option<String>,
}
