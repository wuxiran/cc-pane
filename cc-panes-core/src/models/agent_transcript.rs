use serde::{Deserialize, Serialize};

/// 扁平化的 agent 对话消息（只读 Chat 视图用，不做 Orca 全 block AST）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    pub id: String,
    pub role: TranscriptRole,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptRole {
    User,
    Assistant,
    Reasoning,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAgentTranscriptParams {
    pub cli_tool: String,
    pub resume_session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// 返回最近 N 条消息（user/assistant/reasoning/tool 均计入）。默认 200。
    #[serde(default)]
    pub limit: Option<u32>,
    /// 从末尾再往前跳过的消息数（「加载更早」）。默认 0。
    #[serde(default)]
    pub offset_from_end: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAgentTranscriptResult {
    pub messages: Vec<TranscriptMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    /// 解码得到的消息总数（分页前）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_estimate: Option<u64>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<AgentTranscriptErrorCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTranscriptErrorCode {
    NotFound,
    UnsupportedCli,
    ParseError,
    IoError,
    InvalidSessionId,
}

impl ReadAgentTranscriptResult {
    pub fn ok(
        messages: Vec<TranscriptMessage>,
        file_path: String,
        total_estimate: u64,
        truncated: bool,
    ) -> Self {
        Self {
            messages,
            file_path: Some(file_path),
            total_estimate: Some(total_estimate),
            truncated,
            error_code: None,
            error_message: None,
        }
    }

    pub fn err(code: AgentTranscriptErrorCode, message: impl Into<String>) -> Self {
        Self {
            messages: Vec::new(),
            file_path: None,
            total_estimate: None,
            truncated: false,
            error_code: Some(code),
            error_message: Some(message.into()),
        }
    }
}

pub const DEFAULT_TRANSCRIPT_LIMIT: u32 = 200;
pub const MAX_TRANSCRIPT_LIMIT: u32 = 2_000;
