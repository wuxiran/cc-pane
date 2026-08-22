use cc_cli_adapters::SkillDeliveryMode;
use serde::{Deserialize, Serialize};

use crate::models::terminal::CliTool;

/// Schema version for task dispatch envelopes persisted in TaskBinding metadata.
pub const TASK_DISPATCH_ENVELOPE_VERSION: u32 = 1;

/// A task starts either from a new prompt or by resuming an existing CLI session.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskDispatchMode {
    Prompt,
    Resume,
}

/// Capability of the dispatched CLI to participate in CC-Panes orchestration.
///
/// These are adapter-level capabilities captured at dispatch time. A selected
/// launch profile can still disable the ccpanes MCP server for a particular
/// session, so callers must treat them as eligibility rather than a guarantee
/// that the target process can reach MCP at runtime.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDispatchMcpCapability {
    pub supported: bool,
    pub can_control_orchestration: bool,
    pub can_report_result: bool,
}

/// Stable, durable description of a cross-CLI task dispatch.
///
/// The full prompt remains on TaskBinding.prompt so the metadata remains a
/// compact transport contract rather than a duplicate task payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDispatchEnvelope {
    pub version: u32,
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_cli_tool: Option<String>,
    pub resolved_cli_tool: String,
    pub project_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_kind: Option<String>,
    pub mode: TaskDispatchMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<String>,
    #[serde(default)]
    pub skill_delivery_modes: Vec<SkillDeliveryMode>,
    pub mcp: TaskDispatchMcpCapability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_binding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
}

/// Input used to plan a task dispatch before a terminal session is created.
#[derive(Debug, Clone, Default)]
pub struct TaskDispatchRequest {
    pub cli_tool: Option<String>,
    pub project_path: String,
    pub workspace_name: Option<String>,
    pub profile_id: Option<String>,
    pub runtime_kind: Option<String>,
    pub prompt: Option<String>,
    pub resume_id: Option<String>,
    pub parent_binding_id: Option<String>,
    pub parent_session_id: Option<String>,
}

/// Resolved target and its durable dispatch envelope.
#[derive(Debug, Clone)]
pub struct TaskDispatchPlan {
    pub cli_tool: CliTool,
    pub envelope: TaskDispatchEnvelope,
}

impl TaskDispatchPlan {
    pub fn attach_binding_id(&mut self, binding_id: String) {
        self.envelope.binding_id = Some(binding_id);
    }
}
