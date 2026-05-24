use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub char_count: u64,
    pub token_input: u64,
    pub token_output: u64,
    pub token_cache_read: u64,
    pub token_cache_creation: u64,
}

impl UsageTotals {
    pub fn add_delta(&mut self, delta: &UsageStatsDelta) {
        self.char_count += delta.char_count;
        self.token_input += delta.token_input;
        self.token_output += delta.token_output;
        self.token_cache_read += delta.token_cache_read;
        self.token_cache_creation += delta.token_cache_creation;
    }

    pub fn token_total(&self) -> u64 {
        self.token_input + self.token_output + self.token_cache_read + self.token_cache_creation
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayPoint {
    pub date: String,
    pub claude_chars: u64,
    pub codex_chars: u64,
    pub unknown_chars: u64,
    pub claude_tokens_in: u64,
    pub claude_tokens_out: u64,
    pub claude_cache_read: u64,
    pub claude_cache_creation: u64,
    pub codex_tokens_in: u64,
    pub codex_tokens_out: u64,
    pub codex_cache_read: u64,
    pub codex_cache_creation: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageQueryResult {
    pub series: Vec<UsageDayPoint>,
    pub totals: UsageTotals,
    pub by_cli: HashMap<String, UsageTotals>,
    pub workspaces: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageStatsDelta {
    pub date: String,
    pub cli_tool: String,
    pub workspace_name: String,
    pub char_count: u64,
    pub token_input: u64,
    pub token_output: u64,
    pub token_cache_read: u64,
    pub token_cache_creation: u64,
}

impl UsageStatsDelta {
    pub fn is_empty(&self) -> bool {
        self.char_count == 0
            && self.token_input == 0
            && self.token_output == 0
            && self.token_cache_read == 0
            && self.token_cache_creation == 0
    }
}

#[derive(Debug, Clone)]
pub struct UsageStatsRow {
    pub date: String,
    pub cli_tool: String,
    pub totals: UsageTotals,
}

#[derive(Debug, Clone)]
pub struct UsageEntry {
    pub date: String,
    pub token_input: u64,
    pub token_output: u64,
    pub token_cache_read: u64,
    pub token_cache_creation: u64,
}

impl UsageEntry {
    pub fn is_empty(&self) -> bool {
        self.token_input == 0
            && self.token_output == 0
            && self.token_cache_read == 0
            && self.token_cache_creation == 0
    }
}

#[derive(Debug, Clone)]
pub struct UsageScanState {
    pub jsonl_path: String,
    pub last_byte_offset: u64,
    pub last_mtime_ms: i64,
    pub scanned_at: String,
}
