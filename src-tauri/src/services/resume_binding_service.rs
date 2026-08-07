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

// 主窗 24×500ms = 12s：issued 事件在 PTY spawn 后立刻 emit，而
// bind_pty_session / bind_or_add_created_session 要等 create_session **返回后**
// 才跑——WSL 冷启动实测可超过 5s，旧的 10×500ms 窗口会在 create 返回前耗尽，
// 转入 upsert 后与旧 launchId 叠加即永久丢号（docs/86 缺口 D）。
const BIND_MAX_ATTEMPTS: u32 = 24;
const BIND_RETRY_DELAY_MS: u64 = 500;
// 二次窗：upsert 因「行被占」失败时（launch id 复用的结构错误信号），等 create
// 侧的 bind_or_add_created_session 为本 PTY 插出新行后按 PTY 精确命中。
// 按 PTY 匹配不可能误绑别人的行。
const REBIND_MAX_ATTEMPTS: u32 = 6;
const REBIND_RETRY_DELAY_MS: u64 = 1_000;

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
    match bind_by_pty_window(&service, &payload, BIND_MAX_ATTEMPTS, BIND_RETRY_DELAY_MS).await {
        BindByPtyOutcome::Bound(selected) => {
            record_id = Some(selected.record_id);
            selected_resume_id = selected.resume_session_id;
            if let Some(source) = selected.resume_source {
                selected_source = source;
            }
        }
        BindByPtyOutcome::Rejected => return,
        BindByPtyOutcome::NotFound => {}
    }

    // 重试耗尽仍无行 = 恢复路径（没人替它建行），upsert 兜底。
    // 放在 rejected 之后：CLI 冲突的事件不该建行。
    if record_id.is_none() {
        match upsert_missing_row(&service, &payload) {
            UpsertOutcome::Created(upserted) => {
                record_id = Some(upserted.record_id);
                selected_resume_id = upserted.resume_session_id;
                if let Some(source) = upserted.resume_source {
                    selected_source = source;
                }
            }
            UpsertOutcome::RowOccupied => {
                // launch id 的最新行已被别的 PTY 占用 = 前端复用了旧 launchId
                // （docs/86 缺口 A 的结构错误信号，V29 唯一索引下不可能建第二行）。
                // 不终局：create 返回后 bind_or_add_created_session 会为本 PTY
                // 插出新行，二次窗按 PTY 精确命中即可落库。
                warn!(
                    pty_session_id = %payload.session_id,
                    launch_id = ?payload.launch_id,
                    "bind_resume_id: launch id row occupied by another PTY (stale launch id reuse); entering rebind window"
                );
                match bind_by_pty_window(
                    &service,
                    &payload,
                    REBIND_MAX_ATTEMPTS,
                    REBIND_RETRY_DELAY_MS,
                )
                .await
                {
                    BindByPtyOutcome::Bound(selected) => {
                        record_id = Some(selected.record_id);
                        selected_resume_id = selected.resume_session_id;
                        if let Some(source) = selected.resume_source {
                            selected_source = source;
                        }
                    }
                    BindByPtyOutcome::Rejected => return,
                    BindByPtyOutcome::NotFound => {}
                }
            }
            UpsertOutcome::Skipped => {}
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

/// 主窗/二次窗共用的「按 PTY 精确绑定」循环。来源仲裁与写入在同一事务内完成，
/// 用事务选出的值转发前端，避免并发高优先级写入被陈旧事件载荷覆盖。
enum BindByPtyOutcome {
    Bound(cc_panes_core::repository::SessionStartedUpsertResult),
    /// 该 PTY 的行属于另一个 CLI，事件被拒（不建行、不转发）。
    Rejected,
    NotFound,
}

async fn bind_by_pty_window(
    service: &Arc<LaunchHistoryService>,
    payload: &ResumeIdDetectedPayload,
    max_attempts: u32,
    retry_delay_ms: u64,
) -> BindByPtyOutcome {
    for attempt in 0..max_attempts {
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
            tokio::time::sleep(Duration::from_millis(retry_delay_ms)).await;
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
                return BindByPtyOutcome::Rejected;
            }
        }

        match service.update_resume_session_with_source_by_pty_with_result(
            &payload.session_id,
            &payload.resume_session_id,
            &payload.source,
        ) {
            Ok(Some(selected)) => return BindByPtyOutcome::Bound(selected),
            Ok(None) => {}
            Err(error) => {
                warn!(session_id = %payload.session_id, error = %error, "bind_resume_id: update by pty failed");
            }
        }
        tokio::time::sleep(Duration::from_millis(retry_delay_ms)).await;
    }
    BindByPtyOutcome::NotFound
}

/// `upsert_missing_row` 的分型结果：`RowOccupied` 单列出来是因为它不是终局——
/// create 侧稍后会为本 PTY 建行，调用方要进二次窗而不是放弃。
enum UpsertOutcome {
    Created(cc_panes_core::repository::SessionStartedUpsertResult),
    /// launch id 的最新行已绑定另一个 PTY（前端复用旧 launchId 的结构错误信号）。
    RowOccupied,
    /// 缺关键字段 / CLI 冲突 / 其他写库失败，保留原告警。
    Skipped,
}

/// 行不存在时建行兜底。
///
/// `launch_id` / `project_path` 缺一不可：前者是 `launch_history.project_id`
/// （每次启动唯一，不是项目 id），后者是 NOT NULL 列——没有就无法建出有意义的行，
/// 不要拿占位值硬凑，那会在启动历史里留下指向错误目录的记录。
fn upsert_missing_row(
    service: &Arc<LaunchHistoryService>,
    payload: &ResumeIdDetectedPayload,
) -> UpsertOutcome {
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
        return UpsertOutcome::Skipped;
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
            // 错误分型靠 history_repo 的错误文案；改那边的措辞要同步这里。
            if error.contains("already bound to another PTY") {
                return UpsertOutcome::RowOccupied;
            }
            return UpsertOutcome::Skipped;
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
    UpsertOutcome::Created(upserted)
}

#[cfg(test)]
mod tests {
    use super::{
        expected_cli_for_uuid, upsert_missing_row, ResumeIdDetectedPayload, UpsertOutcome,
    };
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

        let UpsertOutcome::Created(upserted) =
            upsert_missing_row(&svc, &payload(Some("proj-restore"), Some("D:/repo/app")))
        else {
            panic!("应建出行");
        };

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
        assert!(matches!(
            upsert_missing_row(&svc, &payload(None, Some("D:/repo/app"))),
            UpsertOutcome::Skipped
        ));
        assert!(svc
            .find_by_pty_session_id("pty-restore")
            .expect("find")
            .is_none());
    }

    /// project_path 同为 NOT NULL；缺了建出来的行会指向错误目录，宁可不建。
    #[test]
    fn upsert_skips_when_project_path_missing() {
        let svc = service();
        assert!(matches!(
            upsert_missing_row(&svc, &payload(Some("proj-restore"), None)),
            UpsertOutcome::Skipped
        ));
        assert!(svc
            .find_by_pty_session_id("pty-restore")
            .expect("find")
            .is_none());
    }

    /// launch id 的最新行被别的 PTY 占着 = 前端复用了旧 launchId（docs/86 缺口 A
    /// 的结构错误信号）。必须分型为 RowOccupied（调用方进二次窗），不能与普通
    /// 失败混为 Skipped，也绝不能改动被占的那行。
    #[test]
    fn upsert_reports_row_occupied_when_launch_id_bound_to_other_pty() {
        let svc = service();
        let mut first = payload(Some("launch-occupied"), Some("D:/repo/app"));
        first.session_id = "pty-old".into();
        assert!(matches!(
            upsert_missing_row(&svc, &first),
            UpsertOutcome::Created(_)
        ));

        let mut second = payload(Some("launch-occupied"), Some("D:/repo/app"));
        second.session_id = "pty-new".into();
        second.resume_session_id = "0199bb22-3344-7555-8666-777788889999".into();
        assert!(matches!(
            upsert_missing_row(&svc, &second),
            UpsertOutcome::RowOccupied
        ));

        let record = svc
            .find_by_launch_id("launch-occupied")
            .expect("find")
            .expect("row");
        assert_eq!(record.pty_session_id.as_deref(), Some("pty-old"));
        assert_eq!(
            record.resume_session_id.as_deref(),
            Some("0199aa11-2233-7444-8555-666677778888")
        );
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
        assert!(matches!(
            upsert_missing_row(&svc, &issued),
            UpsertOutcome::Created(_)
        ));

        let mut rollout = issued.clone();
        rollout.source = "rollout-scan".into();
        rollout.resume_session_id = "other-resume-id".into();
        let UpsertOutcome::Created(retained) = upsert_missing_row(&svc, &rollout) else {
            panic!("same row remains selected");
        };
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
        assert!(matches!(
            upsert_missing_row(&svc, &claude),
            UpsertOutcome::Created(_)
        ));

        let mut codex = claude.clone();
        codex.cli_tool = Some("codex".into());
        codex.resume_session_id = "019f9057-c7cf-7f73-9fa9-44ae21234567".into();
        assert!(matches!(
            upsert_missing_row(&svc, &codex),
            UpsertOutcome::Skipped
        ));

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
