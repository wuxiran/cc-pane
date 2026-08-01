//! 确定性 resume id 绑定：消费 `terminal-resume-id-detected` 事件并落库。
//!
//! 事件来源（cc-panes-core TerminalService）：
//! - Claude 发号（`claude --session-id`，source = "issued"）
//! - Codex OSC 标题捕获（`tui.terminal_title=["thread-id"]`，source = "osc-title"）
//!
//! 落库后转发 `history-updated` 给前端（前端现有监听器据此更新 tab.resumeId）。
//!
//! 写入策略是 **UPDATE 优先、重试耗尽后 upsert 建行**：launch_history 行通常由
//! 前端 `add_launch_history` / orchestrator `add_with_pty_session` 创建，事件可能
//! 先于行插入到达，因此带短重试等待行出现。
//!
//! 旧恢复路径曾复用 tab 级 `projectId` 作为 launch id；它实际是**上一次** launch 的
//! identity，那行的 `pty_session_id` 已被上次 PTY 占用，`bind_pty_session` 的
//! `(pty_session_id IS NULL OR = ?)` 因而永不命中。现在前端会为每个新 PTY 生成 leaf 级
//! one-shot launch id，但事件早于历史行时仍需这里兜底建行。
//! 曾经只告警不建行，后果是恢复出来的会话永远写不进 resume id → 下次重启它就没有
//! resumeId → 只能开空会话，而这个空会话同样是恢复路径产物，**永久退化不可自愈**
//! （实测一次重启 18/18 个 tab 全无 resumeId，6 条已送达的 resume id 事件全被丢弃）。
//!
//! 因此重试耗尽后走 `upsert_session_started` 建行兜底。只在「行不存在」这一种失败上
//! 兜底——CLI 冲突拒绝与来源优先级判据都必须先过，否则 osc-title 会盖掉 issued。

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

// 来源优先级判据下沉到 cc-panes-core，与 daemon 侧的留存共用同一套规则——
// 两边各写一份必然漂移（daemon 若按"最后写入"留存就会降级 osc-title）。
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

        // Source arbitration and the write happen in one transaction. Use the selected value from
        // that transaction so a concurrent higher-priority writer cannot be overwritten in the
        // frontend by a stale event payload.
        match service.update_resume_session_with_source_by_pty_with_result(
            &payload.session_id,
            &payload.resume_session_id,
            &payload.source,
        ) {
            Ok(Some(selected)) => {
                record_id = Some(selected.record_id);
                selected_resume_id = selected.resume_session_id;
                if let Some(source) = selected.resume_source {
                    selected_source = source;
                }
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

    // 重试耗尽仍无行 = 恢复路径（没人替它建行），upsert 兜底。
    // 放在 rejected 之后：CLI 冲突的事件不该建行。
    if record_id.is_none() {
        if let Some(upserted) = upsert_missing_row(&service, &payload) {
            record_id = Some(upserted.record_id);
            selected_resume_id = upserted.resume_session_id;
            if let Some(source) = upserted.resume_source {
                selected_source = source;
            }
        }
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

/// 行不存在时建行兜底。返回 None 表示没建成（缺关键字段或写库失败），
/// 调用方据此保留原告警。
///
/// `launch_id` / `project_path` 缺一不可：前者是 `launch_history.project_id`
/// （每次启动唯一，不是项目 id），后者是 NOT NULL 列——没有就无法建出有意义的行，
/// 不要拿占位值硬凑，那会在启动历史里留下指向错误目录的记录。
fn upsert_missing_row(
    service: &Arc<LaunchHistoryService>,
    payload: &ResumeIdDetectedPayload,
) -> Option<cc_panes_core::repository::SessionStartedUpsertResult> {
    let (Some(launch_id), Some(project_path)) = (
        payload.launch_id.as_deref(),
        payload.project_path.as_deref(),
    ) else {
        debug!(
            pty_session_id = %payload.session_id,
            has_launch_id = payload.launch_id.is_some(),
            has_project_path = payload.project_path.is_some(),
            "bind_resume_id: cannot upsert launch_history row without launch_id + project_path"
        );
        return None;
    };

    // cli_tool 缺失时按 resume id 的 UUID 版本反推（v4=claude / v7=codex），
    // 落 "none" 会让这行看起来是纯 shell 会话，之后 resume 相关查询会跳过它。
    let cli_tool = payload
        .cli_tool
        .as_deref()
        .or_else(|| expected_cli_for_uuid(&payload.resume_session_id))
        .unwrap_or("none");
    let runtime_kind = payload.runtime_kind.as_deref().unwrap_or("local");

    let upserted = match service.upsert_session_started_with_source(
        launch_id,
        &payload.session_id,
        &payload.resume_session_id,
        cli_tool,
        runtime_kind,
        payload.wsl_distro.as_deref(),
        None, // launch_cwd：事件里没有，留给后续 hook/backfill 回填
        project_path,
        &crate::services::derive_project_name(project_path),
        payload.workspace_path.as_deref(),
        &payload.source,
    ) {
        Ok(result) => result,
        Err(error) => {
            warn!(
                pty_session_id = %payload.session_id,
                launch_id = %launch_id,
                error = %error,
                "bind_resume_id: upsert launch_history row failed"
            );
            return None;
        }
    };

    info!(
        record_id = upserted.record_id,
        pty_session_id = %payload.session_id,
        resume_session_id = %payload.resume_session_id,
        source = %payload.source,
        launch_id = %launch_id,
        "bind_resume_id: launch_history row was missing (restore path); created via upsert"
    );
    Some(upserted)
}

#[cfg(test)]
mod tests {
    use super::{expected_cli_for_uuid, upsert_missing_row, ResumeIdDetectedPayload};
    use cc_panes_core::repository::{Database, HistoryRepository};
    use cc_panes_core::services::{should_replace_source, LaunchHistoryService};
    use std::sync::Arc;

    // bind_resume_id 依赖运行中的 tauri AppHandle，无法脱离应用构造；
    // 这里覆盖事件载荷的反序列化契约（与 terminal_service emit 的 JSON 对应），
    // 以及不依赖 AppHandle 的建行兜底 upsert_missing_row。

    fn service() -> Arc<LaunchHistoryService> {
        // new_in_memory 是 cc-panes-core 的 cfg(test) 内部入口，跨 crate 不可见；
        // src-tauri 侧测试统一用 new_fallback（同为内存库），与 orchestrator_service 测试一致。
        let db = Arc::new(Database::new_fallback().expect("fallback database"));
        Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(
            db,
        ))))
    }

    fn payload(launch_id: Option<&str>, project_path: Option<&str>) -> ResumeIdDetectedPayload {
        ResumeIdDetectedPayload {
            session_id: "pty-restore".into(),
            resume_session_id: "0199aa11-2233-7444-8555-666677778888".into(),
            source: "osc-title".into(),
            cli_tool: Some("codex".into()),
            runtime_kind: Some("wsl".into()),
            launch_id: launch_id.map(Into::into),
            project_path: project_path.map(Into::into),
            workspace_path: None,
            wsl_distro: Some("Ubuntu".into()),
        }
    }

    /// 恢复路径的核心回归：行不存在时必须建行，否则该会话下次重启就没有 resumeId。
    #[test]
    fn upsert_creates_row_when_none_exists_and_records_source() {
        let svc = service();
        assert!(
            svc.find_by_pty_session_id("pty-restore")
                .expect("find")
                .is_none(),
            "前置：库里本来没有这条 PTY 的行"
        );

        let upserted =
            upsert_missing_row(&svc, &payload(Some("proj-restore"), Some("D:/repo/app")))
                .expect("应建出行");

        let record = svc
            .find_by_pty_session_id("pty-restore")
            .expect("find")
            .expect("行已存在");
        assert_eq!(record.id, upserted.record_id);
        assert_eq!(
            record.resume_session_id.as_deref(),
            Some("0199aa11-2233-7444-8555-666677778888")
        );
        // resume_source 必须补写：留空会让后到的低优先级来源覆盖掉它
        assert_eq!(record.resume_source.as_deref(), Some("osc-title"));
        assert_eq!(record.project_name, "app");
        assert_eq!(record.cli_tool, "codex");
    }

    /// launch_id 是 launch_history.project_id（NOT NULL），缺了不能拿占位值硬凑。
    #[test]
    fn upsert_skips_when_launch_id_missing() {
        let svc = service();
        assert!(upsert_missing_row(&svc, &payload(None, Some("D:/repo/app"))).is_none());
        assert!(svc
            .find_by_pty_session_id("pty-restore")
            .expect("find")
            .is_none());
    }

    /// project_path 同为 NOT NULL；缺了建出来的行会指向错误目录，宁可不建。
    #[test]
    fn upsert_skips_when_project_path_missing() {
        let svc = service();
        assert!(upsert_missing_row(&svc, &payload(Some("proj-restore"), None)).is_none());
        assert!(svc
            .find_by_pty_session_id("pty-restore")
            .expect("find")
            .is_none());
    }

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

    #[test]
    fn fallback_cannot_replace_issued_with_rollout_scan() {
        let svc = service();
        let seeded = payload(Some("launch-priority"), Some("D:/repo/app"));
        let mut issued = seeded.clone();
        issued.source = "issued".into();
        issued.resume_session_id = "7a1e2f64-6168-4cb2-9308-9adf0e2d91df".into();
        issued.cli_tool = Some("claude".into());
        upsert_missing_row(&svc, &issued).expect("seed issued row");

        let mut rollout = issued.clone();
        rollout.source = "rollout-scan".into();
        rollout.resume_session_id = "other-resume-id".into();
        let retained = upsert_missing_row(&svc, &rollout).expect("same row remains selected");
        assert_eq!(retained.resume_session_id, issued.resume_session_id);
        assert_eq!(retained.resume_source.as_deref(), Some("issued"));

        let record = svc
            .find_by_launch_id("launch-priority")
            .expect("find")
            .expect("row");
        assert_eq!(
            record.resume_session_id.as_deref(),
            Some(issued.resume_session_id.as_str())
        );
        assert_eq!(record.resume_source.as_deref(), Some("issued"));
    }

    #[test]
    fn fallback_rejects_cli_conflict_without_mutating_row() {
        let svc = service();
        let mut claude = payload(Some("launch-cli-conflict"), Some("D:/repo/app"));
        claude.source = "issued".into();
        claude.resume_session_id = "7a1e2f64-6168-4cb2-9308-9adf0e2d91df".into();
        claude.cli_tool = Some("claude".into());
        upsert_missing_row(&svc, &claude).expect("seed claude row");

        let mut codex = claude.clone();
        codex.cli_tool = Some("codex".into());
        codex.resume_session_id = "019f9057-c7cf-7f73-9fa9-44ae21234567".into();
        assert!(upsert_missing_row(&svc, &codex).is_none());

        let record = svc
            .find_by_launch_id("launch-cli-conflict")
            .expect("find")
            .expect("row");
        assert_eq!(record.cli_tool, "claude");
        assert_eq!(
            record.resume_session_id.as_deref(),
            Some(claude.resume_session_id.as_str())
        );
    }
}
