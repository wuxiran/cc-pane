//! 确定性 resume id 绑定：消费 `terminal-resume-id-detected` 事件并落库。
//!
//! 事件来源（cc-panes-core TerminalService）：
//! - Claude 发号（`claude --session-id`，source = "issued"）
//! - Codex OSC 标题捕获（`tui.terminal_title=["thread-id"]`，source = "osc-title"）
//!
//! 落库后转发 `history-updated` 给前端（前端现有监听器据此更新 tab.resumeId）。
//!
//! 写入策略只 UPDATE 不 INSERT：launch_history 行由前端 `add_launch_history` /
//! orchestrator `add_with_pty_session` 负责创建，事件可能先于行插入到达，
//! 因此带短重试等待行出现；始终查不到则仅告警（tab 侧仍通过事件拿到 id，
//! localStorage 恢复不受影响）。

use crate::services::LaunchHistoryService;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tracing::{debug, info, warn};

/// `terminal-resume-id-detected` 事件载荷（与 terminal_service emit 的 JSON 对应）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeIdDetectedPayload {
    pub session_id: String,
    pub resume_session_id: String,
    pub source: String,
    #[serde(default)]
    pub cli_tool: Option<String>,
    #[serde(default)]
    pub runtime_kind: Option<String>,
    #[serde(default)]
    pub launch_id: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub wsl_distro: Option<String>,
}

const BIND_MAX_ATTEMPTS: u32 = 10;
const BIND_RETRY_DELAY_MS: u64 = 500;

fn expected_cli_for_uuid(resume_session_id: &str) -> Option<&'static str> {
    let version = uuid::Uuid::parse_str(resume_session_id)
        .ok()?
        .get_version_num();
    match version {
        7 => Some("codex"),
        4 => Some("claude"),
        _ => None,
    }
}

fn source_priority(source: &str) -> u8 {
    match source {
        "manual" => 40,
        "issued" | "osc-title" => 30,
        "rollout-scan" | "backfill" => 10,
        "rescue" => 5,
        _ => 0,
    }
}

fn should_replace_source(existing: Option<&str>, incoming: &str) -> bool {
    existing
        .map(|source| source_priority(incoming) >= source_priority(source))
        .unwrap_or(true)
}

/// 将确定性获得的 resume id 绑定到 launch_history，并转发 history-updated。
pub async fn bind_resume_id(
    app_handle: AppHandle,
    service: Arc<LaunchHistoryService>,
    payload: ResumeIdDetectedPayload,
) {
    if let (Some(expected), Some(actual)) = (
        expected_cli_for_uuid(&payload.resume_session_id),
        payload.cli_tool.as_deref(),
    ) {
        if expected != actual {
            warn!(
                resume_session_id = %payload.resume_session_id,
                expected_cli_tool = expected,
                actual_cli_tool = actual,
                "bind_resume_id: resume id UUID version does not match CLI tool"
            );
        }
    }

    let mut record_id: Option<i64> = None;
    let mut selected_resume_id = payload.resume_session_id.clone();
    let mut selected_source = payload.source.clone();
    let mut rejected = false;
    for attempt in 0..BIND_MAX_ATTEMPTS {
        let record = match service.find_by_pty_session_id(&payload.session_id) {
            Ok(record) => record,
            Err(error) => {
                warn!(session_id = %payload.session_id, error = %error, "bind_resume_id: lookup by pty failed");
                None
            }
        };
        let Some(record) = record else {
            debug!(
                session_id = %payload.session_id,
                attempt,
                "bind_resume_id: exact PTY launch_history row not found yet; retrying"
            );
            tokio::time::sleep(Duration::from_millis(BIND_RETRY_DELAY_MS)).await;
            continue;
        };

        if let Some(event_cli_tool) = payload.cli_tool.as_deref() {
            if record.cli_tool != "none" && record.cli_tool != event_cli_tool {
                warn!(
                    record_id = record.id,
                    pty_session_id = %payload.session_id,
                    record_cli_tool = %record.cli_tool,
                    event_cli_tool,
                    "bind_resume_id: rejected event because exact PTY belongs to another CLI tool"
                );
                rejected = true;
                break;
            }
        }

        if !should_replace_source(record.resume_source.as_deref(), &payload.source) {
            if let Some(existing_resume_id) = record.resume_session_id {
                if existing_resume_id != payload.resume_session_id {
                    warn!(
                        record_id = record.id,
                        pty_session_id = %payload.session_id,
                        existing_resume_session_id = %existing_resume_id,
                        existing_source = ?record.resume_source,
                        ignored_resume_session_id = %payload.resume_session_id,
                        ignored_source = %payload.source,
                        "bind_resume_id: ignored lower-priority resume source"
                    );
                }
                selected_resume_id = existing_resume_id;
                selected_source = record
                    .resume_source
                    .unwrap_or_else(|| payload.source.clone());
            }
            record_id = Some(record.id);
            break;
        }

        match service.update_resume_session_with_source_by_pty(
            &payload.session_id,
            &payload.resume_session_id,
            &payload.source,
        ) {
            Ok(Some(id)) => {
                record_id = Some(id);
                break;
            }
            Ok(None) => {}
            Err(error) => {
                warn!(session_id = %payload.session_id, error = %error, "bind_resume_id: update by pty failed");
            }
        }
        tokio::time::sleep(Duration::from_millis(BIND_RETRY_DELAY_MS)).await;
    }

    if rejected {
        return;
    }

    match service.find_by_resume_session_id(&selected_resume_id) {
        Ok(Some(existing)) if existing.pty_session_id.as_deref() != Some(&payload.session_id) => {
            warn!(
                resume_session_id = %selected_resume_id,
                existing_record_id = existing.id,
                existing_pty_session_id = ?existing.pty_session_id,
                current_pty_session_id = %payload.session_id,
                source = %selected_source,
                "bind_resume_id: resume id already assigned to another launch record"
            );
        }
        _ => {}
    }

    match record_id {
        Some(id) => {
            info!(
                record_id = id,
                pty_session_id = %payload.session_id,
            resume_session_id = %selected_resume_id,
            source = %selected_source,
                "bind_resume_id: resume id bound to launch_history"
            );
        }
        None => {
            warn!(
                pty_session_id = %payload.session_id,
                resume_session_id = %selected_resume_id,
                source = %selected_source,
                launch_id = ?payload.launch_id,
                "bind_resume_id: no launch_history row matched; DB record skipped (tab binding via event still works)"
            );
        }
    }

    // 无论落库是否命中，都转发给前端更新 tab.resumeId（前端 App.tsx 已监听 history-updated）
    let _ = app_handle.emit(
        "history-updated",
        serde_json::json!({
            "source": "resume-binding",
            "recordId": record_id,
            "ptySessionId": payload.session_id,
            "resumeSessionId": selected_resume_id,
            "resumeSource": selected_source,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::{expected_cli_for_uuid, should_replace_source, ResumeIdDetectedPayload};

    // bind_resume_id 依赖运行中的 tauri AppHandle，无法脱离应用构造；
    // 这里覆盖事件载荷的反序列化契约（与 terminal_service emit 的 JSON 对应）。

    #[test]
    fn payload_deserializes_full_camel_case_event() {
        let json = r#"{
            "sessionId": "pty-1",
            "resumeSessionId": "resume-abc",
            "source": "issued",
            "cliTool": "claude",
            "runtimeKind": "wsl",
            "launchId": "launch-42",
            "projectPath": "C:/proj",
            "workspacePath": "C:/ws",
            "wslDistro": "Ubuntu"
        }"#;
        let payload: ResumeIdDetectedPayload = serde_json::from_str(json).expect("deserialize");
        assert_eq!(payload.session_id, "pty-1");
        assert_eq!(payload.resume_session_id, "resume-abc");
        assert_eq!(payload.source, "issued");
        assert_eq!(payload.cli_tool.as_deref(), Some("claude"));
        assert_eq!(payload.runtime_kind.as_deref(), Some("wsl"));
        assert_eq!(payload.launch_id.as_deref(), Some("launch-42"));
        assert_eq!(payload.project_path.as_deref(), Some("C:/proj"));
        assert_eq!(payload.workspace_path.as_deref(), Some("C:/ws"));
        assert_eq!(payload.wsl_distro.as_deref(), Some("Ubuntu"));
    }

    #[test]
    fn payload_defaults_optional_fields_to_none() {
        let json = r#"{
            "sessionId": "pty-2",
            "resumeSessionId": "resume-def",
            "source": "osc-title"
        }"#;
        let payload: ResumeIdDetectedPayload = serde_json::from_str(json).expect("deserialize");
        assert_eq!(payload.session_id, "pty-2");
        assert_eq!(payload.source, "osc-title");
        assert!(payload.cli_tool.is_none());
        assert!(payload.runtime_kind.is_none());
        assert!(payload.launch_id.is_none());
        assert!(payload.project_path.is_none());
        assert!(payload.workspace_path.is_none());
        assert!(payload.wsl_distro.is_none());
    }

    #[test]
    fn payload_rejects_missing_required_fields_and_snake_case_keys() {
        // 缺 resumeSessionId
        let missing = r#"{"sessionId": "pty-3", "source": "issued"}"#;
        assert!(serde_json::from_str::<ResumeIdDetectedPayload>(missing).is_err());

        // 事件契约是 camelCase，snake_case 键不被接受
        let snake = r#"{"session_id": "pty-4", "resume_session_id": "r", "source": "issued"}"#;
        assert!(serde_json::from_str::<ResumeIdDetectedPayload>(snake).is_err());
    }

    #[test]
    fn uuid_version_is_only_a_cli_sanity_signal() {
        assert_eq!(
            expected_cli_for_uuid("019f9057-c7cf-7f73-9fa9-44ae21234567"),
            Some("codex")
        );
        assert_eq!(
            expected_cli_for_uuid("7a1e2f64-6168-4cb2-9308-9adf0e2d91df"),
            Some("claude")
        );
        assert_eq!(expected_cli_for_uuid("not-a-uuid"), None);
    }

    #[test]
    fn osc_title_has_priority_over_rollout_scan() {
        assert!(should_replace_source(Some("rollout-scan"), "osc-title"));
        assert!(!should_replace_source(Some("osc-title"), "rollout-scan"));
        assert!(should_replace_source(None, "rollout-scan"));
    }
}
