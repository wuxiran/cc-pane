use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QuickCommandKind {
    Terminal,
    AgentPrompt,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QuickCommandTarget {
    CurrentPane,
    NewTab,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    pub id: String,
    pub name: String,
    pub kind: QuickCommandKind,
    pub text: String,
    pub append_enter: bool,
    pub target: QuickCommandTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_tool: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommandDraft {
    pub name: String,
    pub kind: QuickCommandKind,
    pub text: String,
    pub append_enter: bool,
    pub target: QuickCommandTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_tool: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommandConfig {
    #[serde(default)]
    pub commands: Vec<QuickCommand>,
}
