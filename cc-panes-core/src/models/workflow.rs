//! Staged workflow on a parent TaskBinding (docs/114).
//!
//! A workflow is identified by its parent TaskBinding id. Stages run strictly in
//! order; each stage fans out into child TaskBindings that converge before the
//! next stage starts. Only orchestration progress lives here — the child tasks
//! themselves are ordinary TaskBindings.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

macro_rules! str_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }

        impl std::str::FromStr for $name {
            type Err = String;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($text => Ok(Self::$variant),)+
                    other => Err(format!("Invalid {}: {other}", stringify!($name))),
                }
            }
        }
    };
}

str_enum!(WorkflowStatus {
    Running => "running",
    WaitingApproval => "waiting_approval",
    Done => "done",
    Failed => "failed",
});

str_enum!(WorkflowStageStatus {
    Pending => "pending",
    Running => "running",
    WaitingApproval => "waiting_approval",
    Done => "done",
    Failed => "failed",
});

str_enum!(WorkflowTaskStatus {
    Pending => "pending",
    Claimed => "claimed",
    Running => "running",
    Done => "done",
    Failed => "failed",
});

impl WorkflowStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed)
    }
}

impl WorkflowTaskStatus {
    /// Occupies a concurrency-pool slot.
    pub fn is_in_flight(self) -> bool {
        matches!(self, Self::Claimed | Self::Running)
    }
}

/// One child task to dispatch inside a stage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTaskSpec {
    /// Unique inside its stage; part of the idempotency key.
    pub key: String,
    /// Prompt template; may reference `{{prev}}` / `{{stages.<key>[.<task>]}}`.
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Defaults to the parent binding's project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// Concurrency pool; defaults to the CLI tool id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStageSpec {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Stop before this stage until someone approves it.
    #[serde(default)]
    pub requires_approval: bool,
    pub tasks: Vec<WorkflowTaskSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkflowRequest {
    /// Parent TaskBinding id (= workflow id).
    pub workflow_id: String,
    pub stages: Vec<WorkflowStageSpec>,
    #[serde(default)]
    pub pools: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTask {
    pub key: String,
    pub spec: WorkflowTaskSpec,
    pub pool: String,
    pub status: WorkflowTaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStage {
    pub index: u32,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub requires_approval: bool,
    pub status: WorkflowStageStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved_via: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub tasks: Vec<WorkflowTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub status: WorkflowStatus,
    pub pools: BTreeMap<String, u32>,
    pub stages: Vec<WorkflowStage>,
    pub created_at: String,
    pub updated_at: String,
}

impl Workflow {
    pub fn stage_by_key(&self, key: &str) -> Option<&WorkflowStage> {
        self.stages.iter().find(|stage| stage.key == key)
    }
}

/// Selects a stage for approval: by key or by index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageSelector {
    Key(String),
    Index(u32),
}

/// What the driver saw on a child TaskBinding.
#[derive(Debug, Clone, PartialEq)]
pub enum ChildObservation {
    /// Binding no longer exists.
    Missing,
    /// Still pending / running / waiting.
    Active,
    Completed {
        result: Option<serde_json::Value>,
    },
    Failed {
        reason: Option<String>,
    },
}
