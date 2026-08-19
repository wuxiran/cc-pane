use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub session_id: String,
    pub cli_tool: String,
    pub file_path: String,
    pub cwd: String,
    pub project_path_norm: String,
    pub project_name: String,
    pub workspace_name: Option<String>,
    pub first_prompt: String,
    pub last_summary: String,
    pub message_count: u64,
    pub mtime_ms: i64,
    pub size: u64,
    pub source: String,
    pub wsl_distro: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionIndexScope {
    All,
    Workspace(String),
    Project(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionIndexQuery {
    pub scope: SessionIndexScope,
    pub query: Option<String>,
    pub cli_filter: Option<String>,
    pub limit: usize,
    pub offset: usize,
}

impl Default for SessionIndexQuery {
    fn default() -> Self {
        Self {
            scope: SessionIndexScope::All,
            query: None,
            cli_filter: None,
            limit: 100,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexListParams {
    pub scope: Option<String>,
    pub workspace_name: Option<String>,
    pub project_path: Option<String>,
    pub query: Option<String>,
    pub cli_filter: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

impl SessionIndexListParams {
    pub fn into_query(self) -> Result<SessionIndexQuery, String> {
        let scope_name = trimmed(self.scope).unwrap_or_else(|| "all".to_string());
        let scope = match scope_name.as_str() {
            "all" => SessionIndexScope::All,
            "workspace" => SessionIndexScope::Workspace(
                trimmed(self.workspace_name)
                    .ok_or_else(|| "workspaceName is required for workspace scope".to_string())?,
            ),
            "project" => SessionIndexScope::Project(
                trimmed(self.project_path)
                    .ok_or_else(|| "projectPath is required for project scope".to_string())?,
            ),
            value => return Err(format!("Unsupported session index scope: {value}")),
        };
        let cli_filter = trimmed(self.cli_filter);
        if let Some(cli) = cli_filter.as_deref() {
            if !matches!(cli, "claude" | "codex" | "pi" | "omp") {
                return Err(format!("Unsupported session index CLI: {cli}"));
            }
        }
        Ok(SessionIndexQuery {
            scope,
            query: trimmed(self.query),
            cli_filter,
            limit: self.limit.unwrap_or(100),
            offset: self.offset.unwrap_or(0),
        })
    }
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionScanState {
    pub file_path: String,
    pub mtime_ms: i64,
    pub size: u64,
    pub scanned_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSessionTranscript {
    pub session_id: String,
    pub cwd: String,
    /// Creation timestamp from formats that persist it in the session header.
    ///
    /// Pi uses this only for a conservative launch-history backfill match; it
    /// is not shown in the session index itself.
    pub header_timestamp: Option<String>,
    pub first_prompt: String,
    pub last_summary: String,
    pub message_count: u64,
    pub bytes_read: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexScanReport {
    pub roots_scanned: u64,
    pub files_seen: u64,
    pub files_parsed: u64,
    pub files_skipped: u64,
    pub bytes_read: u64,
}

#[cfg(test)]
mod tests {
    use super::{SessionIndexListParams, SessionIndexScope};

    #[test]
    fn session_index_list_params_require_selected_scope_value() {
        let workspace = SessionIndexListParams {
            scope: Some("workspace".to_string()),
            workspace_name: Some("  main  ".to_string()),
            limit: Some(25),
            offset: Some(50),
            ..SessionIndexListParams::default()
        }
        .into_query()
        .expect("workspace query");
        assert_eq!(
            workspace.scope,
            SessionIndexScope::Workspace("main".to_string())
        );
        assert_eq!((workspace.limit, workspace.offset), (25, 50));

        let missing_project = SessionIndexListParams {
            scope: Some("project".to_string()),
            project_path: Some("  ".to_string()),
            ..SessionIndexListParams::default()
        }
        .into_query();
        assert_eq!(
            missing_project.expect_err("project path is required"),
            "projectPath is required for project scope"
        );
    }

    #[test]
    fn session_index_list_params_reject_unknown_scope_and_cli() {
        let invalid_scope = SessionIndexListParams {
            scope: Some("terminal".to_string()),
            ..SessionIndexListParams::default()
        }
        .into_query();
        assert_eq!(
            invalid_scope.expect_err("scope is invalid"),
            "Unsupported session index scope: terminal"
        );

        let invalid_cli = SessionIndexListParams {
            cli_filter: Some("gemini".to_string()),
            ..SessionIndexListParams::default()
        }
        .into_query();
        assert_eq!(
            invalid_cli.expect_err("cli is invalid"),
            "Unsupported session index CLI: gemini"
        );

        let pi = SessionIndexListParams {
            cli_filter: Some("pi".to_string()),
            ..SessionIndexListParams::default()
        }
        .into_query()
        .expect("Pi is a supported session index CLI");
        assert_eq!(pi.cli_filter.as_deref(), Some("pi"));
    }
}
