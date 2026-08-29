use cc_panes_core::models::{ReadAgentTranscriptParams, ReadAgentTranscriptResult};
use cc_panes_core::services::read_agent_transcript;

#[tauri::command]
pub fn read_agent_transcript_cmd(params: ReadAgentTranscriptParams) -> ReadAgentTranscriptResult {
    read_agent_transcript(params)
}
