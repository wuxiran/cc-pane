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

/// 将确定性获得的 resume id 绑定到 launch_history，并转发 history-updated。
pub async fn bind_resume_id(
    app_handle: AppHandle,
    service: Arc<LaunchHistoryService>,
    payload: ResumeIdDetectedPayload,
) {
    // 同一 resume id 被分配给其他 launch 时高声告警（理论上确定性通道不会发生；
    // 出现即说明上游捕获有 bug 或 backfill 开关期间产生了脏数据）
    match service.find_by_resume_session_id(&payload.resume_session_id) {
        Ok(Some(existing)) if existing.pty_session_id.as_deref() != Some(&payload.session_id) => {
            warn!(
                resume_session_id = %payload.resume_session_id,
                existing_record_id = existing.id,
                existing_pty_session_id = ?existing.pty_session_id,
                current_pty_session_id = %payload.session_id,
                source = %payload.source,
                "bind_resume_id: resume id already assigned to another launch record"
            );
        }
        _ => {}
    }

    let mut record_id: Option<i64> = None;
    for attempt in 0..BIND_MAX_ATTEMPTS {
        // 优先按 pty_session_id 命中（orchestrator add_with_pty_session 路径）
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

        // 其次按 launch_id 命中（GUI 路径：前端 add_launch_history 以 projectId 为 launch_id，
        // 行里尚无 pty_session_id）。update_session_started 会同时补上 pty。
        if let Some(launch_id) = payload.launch_id.as_deref() {
            match service.update_session_started(
                launch_id,
                &payload.session_id,
                &payload.resume_session_id,
                payload.cli_tool.as_deref().unwrap_or("none"),
                payload.runtime_kind.as_deref().unwrap_or("local"),
                payload.wsl_distro.as_deref(),
                None,
            ) {
                Ok(Some(id)) => {
                    if let Err(error) = service.update_resume_source(id, &payload.source) {
                        warn!(record_id = id, error = %error, "bind_resume_id: update_resume_source failed");
                    }
                    record_id = Some(id);
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    warn!(launch_id = %launch_id, error = %error, "bind_resume_id: update by launch_id failed");
                }
            }
        }

        debug!(
            session_id = %payload.session_id,
            attempt,
            "bind_resume_id: launch_history row not found yet; retrying"
        );
        tokio::time::sleep(Duration::from_millis(BIND_RETRY_DELAY_MS)).await;
    }

    match record_id {
        Some(id) => {
            info!(
                record_id = id,
                pty_session_id = %payload.session_id,
                resume_session_id = %payload.resume_session_id,
                source = %payload.source,
                "bind_resume_id: resume id bound to launch_history"
            );
        }
        None => {
            warn!(
                pty_session_id = %payload.session_id,
                resume_session_id = %payload.resume_session_id,
                source = %payload.source,
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
            "resumeSessionId": payload.resume_session_id,
            "resumeSource": payload.source,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::ResumeIdDetectedPayload;

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
}
