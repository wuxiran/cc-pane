//! 会话出生凭证落库：三条创建路径（Tauri 命令 / REST / orchestrator launch_task）共用。
//!
//! 恢复期的身份校验（`identityMatches`）比对的是 SQLite `terminal_session_provenance`
//! 里的 daemonGeneration + birthNonce。凭证行缺失 = 该会话在 app 重启后被
//! identity-mismatch 永久拦下，无法自动接管。此前只有 Tauri 命令与 REST 两条路径写，
//! orchestrator 的 MCP `launch_task` 从不写 —— 派发出去的 worker 会话全体缺凭证。
//!
//! 三处共用同一份实现，保证行为一致（含 fail-closed 清理语义）。

use crate::models::{CreateSessionRequest, SavedSession};
use crate::services::session_restore_service::SessionRestoreService;
use crate::services::terminal_service::KillReason;
use crate::services::TerminalBackend;
use crate::utils::error::AppError;
use crate::utils::AppResult;
use tracing::{info, warn};

/// 取 daemon 下发的不可变出生凭证并落库；新建（非复用）时一并写初始观测行。
pub fn persist_created_session_observation(
    backend: &dyn TerminalBackend,
    session_restore_service: &SessionRestoreService,
    request: &CreateSessionRequest,
    session_id: &str,
    reused_existing: bool,
) -> AppResult<()> {
    let provenance = backend
        .session_provenance(session_id)?
        .ok_or_else(|| AppError::from("claim-capable daemon omitted session provenance"))?;
    session_restore_service
        .save_provenance(&provenance)
        .map_err(AppError::from)?;
    if !reused_existing {
        if let Some(observation) = SavedSession::from_creation(request, &provenance) {
            session_restore_service
                .save_initial_observation(&observation)
                .map_err(AppError::from)?;
        }
    }
    Ok(())
}

/// 落库失败后的清理：复用既有会话时只释放写权限，新建会话则杀掉。
pub fn cleanup_failed_session_persistence(
    backend: &dyn TerminalBackend,
    session_id: &str,
    reused_expected_session: bool,
) -> AppResult<()> {
    if reused_expected_session {
        backend.release_session(session_id)
    } else {
        backend.kill_with_reason(session_id, KillReason::Unknown)
    }
}

/// fail-closed 组合：claims-capable 后端必须在返回 session id 前把凭证写进 SQLite，
/// 写不进去就把刚建的会话清理掉并把错误抛给调用方——绝不静默吞掉。
///
/// 非 claims-capable 后端（老 daemon / 进程内后端）没有凭证能力，直接 no-op。
pub fn persist_created_session_or_cleanup(
    backend: &dyn TerminalBackend,
    session_restore_service: &SessionRestoreService,
    request: &CreateSessionRequest,
    session_id: &str,
    reused_existing: bool,
) -> AppResult<()> {
    if !backend.claims_supported() {
        return Ok(());
    }
    if let Err(error) = persist_created_session_observation(
        backend,
        session_restore_service,
        request,
        session_id,
        reused_existing,
    ) {
        if let Err(cleanup_error) =
            cleanup_failed_session_persistence(backend, session_id, reused_existing)
        {
            warn!(
                session_id,
                error = %cleanup_error,
                "failed to clean up session after provenance persistence failure"
            );
        }
        return Err(error);
    }
    Ok(())
}

/// 启动期一次性回填结果。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ProvenanceBackfillReport {
    /// SQLite 中「有观测行但无凭证行」的会话数
    pub missing: usize,
    /// 成功补写凭证的会话数
    pub backfilled: usize,
    /// daemon 里已不存在（查不到凭证）而跳过的会话数
    pub skipped_dead: usize,
    /// 查询/写入失败的会话数
    pub failed: usize,
}

/// 治存量：对 SQLite 里「有观测行但无凭证行」的会话逐个向 daemon 反查凭证并补写。
///
/// 幂等——补写成功后下次启动就查不到缺行，整体是 no-op。死会话在 daemon 里查不到
/// 凭证（返回 `None`），跳过即可：它们本来也没有可接管的 PTY。
pub fn backfill_missing_provenance(
    backend: &dyn TerminalBackend,
    session_restore_service: &SessionRestoreService,
) -> Result<ProvenanceBackfillReport, String> {
    if !backend.claims_supported() {
        return Ok(ProvenanceBackfillReport::default());
    }
    let missing = session_restore_service.list_sessions_missing_provenance()?;
    let mut report = ProvenanceBackfillReport {
        missing: missing.len(),
        ..Default::default()
    };
    for session_id in &missing {
        match backend.session_provenance(session_id) {
            Ok(Some(provenance)) => match session_restore_service.save_provenance(&provenance) {
                Ok(()) => report.backfilled += 1,
                Err(error) => {
                    report.failed += 1;
                    warn!(session_id, error = %error, "failed to backfill session provenance");
                }
            },
            Ok(None) => report.skipped_dead += 1,
            Err(error) => {
                report.failed += 1;
                warn!(session_id, error = %error, "failed to read session provenance for backfill");
            }
        }
    }
    if report.missing > 0 {
        info!(
            missing = report.missing,
            backfilled = report.backfilled,
            skipped_dead = report.skipped_dead,
            failed = report.failed,
            "terminal session provenance backfill finished"
        );
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TerminalSessionProvenance;
    use crate::repository::Database;
    use crate::services::terminal_service::SessionOutput;
    use crate::services::SessionStatusInfo;
    use crate::utils::AppPaths;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FakeBackend {
        claims: bool,
        provenance: HashMap<String, TerminalSessionProvenance>,
        provenance_error: Option<String>,
        killed: Mutex<Vec<String>>,
        released: Mutex<Vec<String>>,
    }

    impl TerminalBackend for FakeBackend {
        fn create_session(&self, _request: CreateSessionRequest) -> AppResult<String> {
            Ok("unused".to_string())
        }
        fn write(&self, _session_id: &str, _data: &str) -> AppResult<()> {
            Ok(())
        }
        fn submit_text_to_session(&self, _session_id: &str, _text: &str) -> AppResult<()> {
            Ok(())
        }
        fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> AppResult<()> {
            Ok(())
        }
        fn kill(&self, session_id: &str) -> AppResult<()> {
            self.killed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(session_id.to_string());
            Ok(())
        }
        fn release_session(&self, session_id: &str) -> AppResult<()> {
            self.released
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(session_id.to_string());
            Ok(())
        }
        fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
            Ok(Vec::new())
        }
        fn get_session_status(&self, _session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
            Ok(None)
        }
        fn get_session_output(
            &self,
            session_id: &str,
            _lines: usize,
        ) -> AppResult<crate::services::terminal_service::SessionOutput> {
            Ok(SessionOutput {
                session_id: session_id.to_string(),
                lines: Vec::new(),
            })
        }
        fn get_session_replay_snapshot(
            &self,
            _session_id: &str,
        ) -> AppResult<Option<crate::models::TerminalReplaySnapshot>> {
            Ok(None)
        }
        fn claims_supported(&self) -> bool {
            self.claims
        }
        fn session_provenance(
            &self,
            session_id: &str,
        ) -> AppResult<Option<TerminalSessionProvenance>> {
            if let Some(error) = &self.provenance_error {
                return Err(AppError::from(error.clone()));
            }
            Ok(self.provenance.get(session_id).cloned())
        }
    }

    fn provenance(session_id: &str) -> TerminalSessionProvenance {
        TerminalSessionProvenance {
            session_id: session_id.to_string(),
            daemon_generation: 7,
            birth_nonce: format!("nonce-{session_id}"),
            origin_instance_id: Some("inst-1".to_string()),
            origin_layout_id: Some("layout-1".to_string()),
            origin_tab_id: Some("tab-1".to_string()),
            origin_terminal_pane_id: Some("leaf-1".to_string()),
            project_path: "/repo".to_string(),
            runtime_kind: "local".to_string(),
            cli_tool: "claude".to_string(),
            resume_id: None,
            created_at_ms: 1_000,
        }
    }

    fn request() -> CreateSessionRequest {
        serde_json::from_value(serde_json::json!({
            "projectPath": "/repo",
            "cols": 80,
            "rows": 24,
        }))
        .expect("create request")
    }

    fn make_service() -> (SessionRestoreService, tempfile::TempDir) {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let app_paths = Arc::new(AppPaths::new(Some(
            tmp.path().to_string_lossy().to_string(),
        )));
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        (SessionRestoreService::new(db, app_paths), tmp)
    }

    #[test]
    fn persist_is_noop_without_claims_support() {
        let (service, _tmp) = make_service();
        let backend = FakeBackend {
            claims: false,
            ..Default::default()
        };
        persist_created_session_or_cleanup(&backend, &service, &request(), "s1", false)
            .expect("no-op");
        assert!(backend
            .killed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty());
        assert!(service
            .list_sessions_missing_provenance()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn persist_writes_provenance_for_claim_capable_backend() {
        let (service, _tmp) = make_service();
        let mut map = HashMap::new();
        map.insert("s1".to_string(), provenance("s1"));
        let backend = FakeBackend {
            claims: true,
            provenance: map,
            ..Default::default()
        };
        persist_created_session_or_cleanup(&backend, &service, &request(), "s1", false)
            .expect("persist");

        let sessions = service.load_sessions().expect("load");
        let saved = sessions
            .iter()
            .find(|s| s.session_id == "s1")
            .expect("observation row");
        assert_eq!(saved.daemon_generation, Some(7));
        assert_eq!(saved.birth_nonce.as_deref(), Some("nonce-s1"));
        assert!(service
            .list_sessions_missing_provenance()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn persist_failure_kills_new_session_and_propagates() {
        let (service, _tmp) = make_service();
        let backend = FakeBackend {
            claims: true,
            provenance_error: Some("daemon offline".to_string()),
            ..Default::default()
        };
        let error = persist_created_session_or_cleanup(&backend, &service, &request(), "s1", false)
            .expect_err("must fail closed");
        assert!(error.to_string().contains("daemon offline"));
        assert_eq!(
            backend
                .killed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_slice(),
            ["s1".to_string()]
        );
    }

    #[test]
    fn persist_failure_releases_reused_session_instead_of_killing() {
        let (service, _tmp) = make_service();
        let backend = FakeBackend {
            claims: true,
            provenance_error: Some("daemon offline".to_string()),
            ..Default::default()
        };
        persist_created_session_or_cleanup(&backend, &service, &request(), "s1", true)
            .expect_err("must fail closed");
        assert!(backend
            .killed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty());
        assert_eq!(
            backend
                .released
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_slice(),
            ["s1".to_string()]
        );
    }

    #[test]
    fn backfill_fills_missing_rows_and_skips_dead_sessions() {
        let (service, _tmp) = make_service();
        // 造两行观测：alive 在 daemon 里查得到凭证，dead 查不到。
        let mut alive =
            crate::models::SavedSession::from_creation(&request(), &provenance("alive"))
                .expect("saved");
        alive.session_id = "alive".to_string();
        let mut dead = crate::models::SavedSession::from_creation(&request(), &provenance("dead"))
            .expect("saved");
        dead.session_id = "dead".to_string();
        service.save_sessions(&[alive, dead]).expect("save");
        assert_eq!(service.list_sessions_missing_provenance().unwrap().len(), 2);

        let mut map = HashMap::new();
        map.insert("alive".to_string(), provenance("alive"));
        let backend = FakeBackend {
            claims: true,
            provenance: map,
            ..Default::default()
        };
        let report = backfill_missing_provenance(&backend, &service).expect("backfill");
        assert_eq!(report.missing, 2);
        assert_eq!(report.backfilled, 1);
        assert_eq!(report.skipped_dead, 1);
        assert_eq!(report.failed, 0);

        // 幂等：第二次只剩死会话那行，且不再重复写入。
        let second = backfill_missing_provenance(&backend, &service).expect("backfill again");
        assert_eq!(second.missing, 1);
        assert_eq!(second.backfilled, 0);
        assert_eq!(second.skipped_dead, 1);
    }

    /// 幂等加强：已有凭证行**绝不被覆盖**，且连续两轮报告逐字段相同。
    ///
    /// 覆盖是真实风险：daemon 重启后会给同一 session id 发**新世代**的凭证
    /// （daemon_generation / birth_nonce 都变）。若回填不看「是否已有行」而
    /// 一律写入，重启一次就把存量会话的出生凭证换成新世代的——身份核对随即
    /// 全部通过，identity-mismatch 这道防线等于形同虚设，接管到错误的 PTY 也
    /// 不会被拦。这条用「daemon 改口」的场景把不覆盖钉住。
    #[test]
    fn backfill_never_overwrites_existing_provenance_rows() {
        let (service, _tmp) = make_service();
        let mut alive =
            crate::models::SavedSession::from_creation(&request(), &provenance("alive"))
                .expect("saved");
        alive.session_id = "alive".to_string();
        service.save_sessions(&[alive]).expect("save");

        let mut map = HashMap::new();
        map.insert("alive".to_string(), provenance("alive"));
        let mut backend = FakeBackend {
            claims: true,
            provenance: map,
            ..Default::default()
        };

        let first = backfill_missing_provenance(&backend, &service).expect("backfill");
        assert_eq!(first.backfilled, 1);

        let stored = |service: &SessionRestoreService| {
            let sessions = service.load_sessions().expect("load");
            let row = sessions
                .iter()
                .find(|s| s.session_id == "alive")
                .expect("row")
                .clone();
            (row.daemon_generation, row.birth_nonce)
        };
        let after_first = stored(&service);
        assert_eq!(after_first, (Some(7), Some("nonce-alive".to_string())));

        // daemon 重启：同一 session id 改口报新世代的凭证。
        let mut rebirth = provenance("alive");
        rebirth.daemon_generation = 99;
        rebirth.birth_nonce = "nonce-rebirth".to_string();
        backend.provenance.insert("alive".to_string(), rebirth);

        let second = backfill_missing_provenance(&backend, &service).expect("second backfill");
        let third = backfill_missing_provenance(&backend, &service).expect("third backfill");

        assert_eq!(
            second, third,
            "连续两轮回填的报告必须逐字段相同（稳定不动点）"
        );
        assert_eq!(
            second,
            ProvenanceBackfillReport {
                missing: 0,
                backfilled: 0,
                skipped_dead: 0,
                failed: 0,
            },
            "已补齐的库上再跑必须整体 no-op"
        );
        assert_eq!(
            stored(&service),
            after_first,
            "已有凭证行被 daemon 的新世代凭证覆盖了——identity-mismatch 防线会因此形同虚设"
        );
    }

    /// 死会话不该被反复计成失败，且报告在多轮之间稳定（不动点）。
    /// 回填跑在启动路径上，报告抖动会让「上次启动到底补没补上」无从判断。
    #[test]
    fn backfill_report_is_stable_across_consecutive_runs_with_dead_sessions() {
        let (service, _tmp) = make_service();
        let mut dead = crate::models::SavedSession::from_creation(&request(), &provenance("dead"))
            .expect("saved");
        dead.session_id = "dead".to_string();
        service.save_sessions(&[dead]).expect("save");

        let backend = FakeBackend {
            claims: true,
            ..Default::default()
        };

        let first = backfill_missing_provenance(&backend, &service).expect("first");
        let second = backfill_missing_provenance(&backend, &service).expect("second");

        assert_eq!(first, second, "死会话轮次之间报告必须一致");
        assert_eq!(
            first,
            ProvenanceBackfillReport {
                missing: 1,
                backfilled: 0,
                skipped_dead: 1,
                failed: 0,
            },
            "daemon 查不到凭证 = 死会话（skipped_dead），不是失败（failed）"
        );
    }

    #[test]
    fn backfill_is_noop_without_claims_support() {
        let (service, _tmp) = make_service();
        let backend = FakeBackend::default();
        assert_eq!(
            backfill_missing_provenance(&backend, &service).expect("noop"),
            ProvenanceBackfillReport::default()
        );
    }
}
