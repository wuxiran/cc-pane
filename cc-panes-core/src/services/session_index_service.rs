use super::session_index_parser::parse_session_transcript;
use super::session_index_roots::{
    collect_jsonl_files, collect_scan_roots, normalize_path, path_has_prefix, path_name,
    registered_projects, RegisteredProject, ScanRoot,
};
use crate::models::{
    ParsedSessionTranscript, SessionIndexEntry, SessionIndexQuery, SessionIndexScanReport,
    SessionIndexScope, WslDistro,
};
use crate::repository::{LaunchRecord, SessionIndexRepository};
use crate::services::{LaunchHistoryService, SettingsService, WorkspaceService};
use crate::utils::{error::AppError, AppResult};
use chrono::{DateTime, Utc};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::time::sleep;
use tracing::{info, warn};

const SESSION_SCAN_INTERVAL_SECS: u64 = 300;
const SESSION_INDEX_ALGO_VERSION: u64 = 2;
const PI_RESUME_MATCH_WINDOW_SECS: i64 = 120;

#[derive(Debug)]
struct SessionIdentity {
    project_path_norm: String,
    project_name: String,
    workspace_name: Option<String>,
    wsl_distro: Option<String>,
}

pub struct SessionIndexService {
    repo: Arc<SessionIndexRepository>,
    launch_history: Arc<LaunchHistoryService>,
    workspace_service: Arc<WorkspaceService>,
    settings: Option<Arc<SettingsService>>,
    wsl_distros: Mutex<Vec<WslDistro>>,
    background_started: AtomicBool,
    scan_running: AtomicBool,
    last_scan_report: Mutex<SessionIndexScanReport>,
}

impl SessionIndexService {
    pub fn new(
        repo: Arc<SessionIndexRepository>,
        launch_history: Arc<LaunchHistoryService>,
        workspace_service: Arc<WorkspaceService>,
    ) -> Self {
        Self {
            repo,
            launch_history,
            workspace_service,
            settings: None,
            wsl_distros: Mutex::new(Vec::new()),
            background_started: AtomicBool::new(false),
            scan_running: AtomicBool::new(false),
            last_scan_report: Mutex::new(SessionIndexScanReport::default()),
        }
    }

    pub fn new_with_settings(
        repo: Arc<SessionIndexRepository>,
        launch_history: Arc<LaunchHistoryService>,
        workspace_service: Arc<WorkspaceService>,
        settings: Arc<SettingsService>,
    ) -> Self {
        Self {
            settings: Some(settings),
            ..Self::new(repo, launch_history, workspace_service)
        }
    }

    pub fn start_background_tasks(self: &Arc<Self>) {
        if self
            .background_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(handle) => handle,
            Err(error) => {
                self.background_started.store(false, Ordering::SeqCst);
                warn!(err = %error, "Session index background task requires Tokio");
                return;
            }
        };
        let service = self.clone();
        handle.spawn(async move {
            // 首扫不做 WSL discovery；空缓存确保不会访问 \\wsl$ 或唤醒 VM。
            service.clone().refresh_from_cache_logged().await;
            loop {
                sleep(Duration::from_secs(SESSION_SCAN_INTERVAL_SECS)).await;
                service.refresh_wsl_distros().await;
                service.clone().refresh_from_cache_logged().await;
            }
        });
    }

    pub fn list_sessions(&self, mut query: SessionIndexQuery) -> AppResult<Vec<SessionIndexEntry>> {
        if let SessionIndexScope::Project(path) = &mut query.scope {
            *path = normalize_path(path);
        }
        self.repo
            .list_sessions_indexed(&query)
            .map_err(AppError::from)
    }

    pub async fn refresh_session_index(self: Arc<Self>) -> AppResult<SessionIndexScanReport> {
        self.refresh_wsl_distros().await;
        self.refresh_from_cache_async().await
    }

    pub fn codex_rollout_exists(&self, session_id: &str, wsl_distro: Option<&str>) -> Option<bool> {
        crate::services::codex_rollout_exists(session_id, wsl_distro)
    }

    pub fn last_scan_report(&self) -> SessionIndexScanReport {
        self.last_scan_report
            .lock()
            .map(|report| report.clone())
            .unwrap_or_default()
    }

    fn refresh_from_cache(&self) -> AppResult<SessionIndexScanReport> {
        if self
            .scan_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(self.last_scan_report());
        }
        struct ScanGuard<'a>(&'a AtomicBool);
        impl Drop for ScanGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = ScanGuard(&self.scan_running);

        self.repo
            .ensure_scan_algo_version(SESSION_INDEX_ALGO_VERSION)
            .map_err(AppError::from)?;
        let report = self.scan_all().map_err(AppError::from)?;
        if let Ok(mut current) = self.last_scan_report.lock() {
            *current = report.clone();
        }
        Ok(report)
    }

    async fn refresh_from_cache_async(self: Arc<Self>) -> AppResult<SessionIndexScanReport> {
        tokio::task::spawn_blocking(move || self.refresh_from_cache())
            .await
            .map_err(|error| AppError::from(error.to_string()))?
    }

    async fn refresh_from_cache_logged(self: Arc<Self>) {
        match self.refresh_from_cache_async().await {
            Ok(report) => info!(
                roots = report.roots_scanned,
                seen = report.files_seen,
                parsed = report.files_parsed,
                skipped = report.files_skipped,
                bytes = report.bytes_read,
                "Session index refresh completed"
            ),
            Err(error) => warn!(err = %error, "Session index refresh failed"),
        }
    }

    async fn refresh_wsl_distros(&self) {
        #[cfg(target_os = "windows")]
        {
            if !self.wsl_scan_allowed() {
                if let Ok(mut cache) = self.wsl_distros.lock() {
                    cache.clear();
                }
                return;
            }
            match crate::services::wsl_discovery_service::discover(&[]).await {
                Ok(distros) => {
                    if let Ok(mut cache) = self.wsl_distros.lock() {
                        *cache = distros;
                    }
                }
                Err(error) => warn!(err = %error, "Failed to discover WSL for session index"),
            }
        }
        #[cfg(not(target_os = "windows"))]
        if let Ok(mut cache) = self.wsl_distros.lock() {
            cache.clear();
        }
    }

    fn wsl_scan_allowed(&self) -> bool {
        let disabled = self
            .settings
            .as_ref()
            .is_some_and(|settings| settings.get_settings().general.disable_wsl_usage_scan);
        !disabled && crate::services::wsl_discovery_service::is_wsl_vm_running()
    }

    fn scan_all(&self) -> Result<SessionIndexScanReport, String> {
        let cached_distros = self
            .wsl_distros
            .lock()
            .map_err(|_| "Session index WSL cache lock poisoned".to_string())?
            .clone();
        let roots = collect_scan_roots(&cached_distros, self.wsl_scan_allowed());
        let registered = registered_projects(&self.workspace_service);
        // Pi has no deterministic PTY hook. Load the launch candidates once
        // for this refresh instead of issuing a full history query per JSONL.
        let mut pi_launch_records = self.pi_launch_records();
        let mut report = SessionIndexScanReport::default();
        for root in roots {
            report.roots_scanned += 1;
            for path in collect_jsonl_files(&root.path) {
                report.files_seen += 1;
                if let Err(error) = self.scan_file_with_pi_launch_records(
                    &root,
                    &path,
                    &registered,
                    &mut report,
                    &mut pi_launch_records,
                ) {
                    warn!(path = %path.display(), err = %error, "Failed to index session transcript");
                }
            }
        }
        Ok(report)
    }

    #[cfg(test)]
    fn scan_file(
        &self,
        root: &ScanRoot,
        path: &Path,
        registered: &[RegisteredProject],
        report: &mut SessionIndexScanReport,
    ) -> Result<(), String> {
        let mut pi_launch_records = self.pi_launch_records();
        self.scan_file_with_pi_launch_records(
            root,
            path,
            registered,
            report,
            &mut pi_launch_records,
        )
    }

    fn scan_file_with_pi_launch_records(
        &self,
        root: &ScanRoot,
        path: &Path,
        registered: &[RegisteredProject],
        report: &mut SessionIndexScanReport,
        pi_launch_records: &mut [LaunchRecord],
    ) -> Result<(), String> {
        let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
        let mtime_ms = modified_mtime_ms(&metadata);
        let size = metadata.len();
        let file_path = path.to_string_lossy().to_string();
        let scan_state = self.repo.get_scan_state(&file_path)?;
        if should_skip_file(
            scan_state.map(|state| (state.mtime_ms, state.size)),
            mtime_ms,
            size,
        ) {
            report.files_skipped += 1;
            return Ok(());
        }

        let mut parsed = parse_session_transcript(root.cli_tool, path)?;
        self.backfill_pi_resume_session(root, &parsed, pi_launch_records);
        let identity = self.resolve_identity(&parsed.session_id, &parsed.cwd, registered, root);
        if parsed.cwd.is_empty() {
            parsed.cwd = identity.project_path_norm.clone();
        }
        self.repo.upsert_session(&SessionIndexEntry {
            session_id: parsed.session_id,
            cli_tool: root.cli_tool.to_string(),
            file_path: file_path.clone(),
            cwd: parsed.cwd,
            project_path_norm: identity.project_path_norm,
            project_name: identity.project_name,
            workspace_name: identity.workspace_name,
            first_prompt: parsed.first_prompt,
            last_summary: parsed.last_summary,
            message_count: parsed.message_count,
            mtime_ms,
            size,
            source: root.source.to_string(),
            wsl_distro: identity.wsl_distro,
            updated_at: Utc::now().to_rfc3339(),
        })?;
        self.repo.upsert_scan_state(&file_path, mtime_ms, size)?;
        report.files_parsed += 1;
        report.bytes_read += parsed.bytes_read;
        Ok(())
    }

    fn pi_launch_records(&self) -> Vec<LaunchRecord> {
        self.launch_history.list(2_000).unwrap_or_else(|error| {
            warn!(err = %error, "Failed to list launch history for Pi session binding");
            Vec::new()
        })
    }

    /// Bind a Pi session file to a launch record only when every available
    /// identity dimension yields one and only one candidate. Pi does not emit
    /// the deterministic PTY hook event used by Claude/Codex, so filename
    /// matching is deliberately never a fallback here.
    fn backfill_pi_resume_session(
        &self,
        root: &ScanRoot,
        parsed: &ParsedSessionTranscript,
        launch_records: &mut [LaunchRecord],
    ) {
        if !matches!(root.cli_tool, "pi" | "omp") {
            return;
        }
        let Some(header_timestamp) = parsed.header_timestamp.as_deref() else {
            return;
        };
        let Some(header_time) = parse_rfc3339_utc(header_timestamp) else {
            return;
        };
        let cwd_norm = normalize_path(&parsed.cwd);
        if cwd_norm.is_empty() {
            return;
        }
        let runtime_kind = if root.source == "wsl" { "wsl" } else { "local" };
        let candidates = launch_records
            .iter()
            .enumerate()
            .filter(|record| {
                let record = record.1;
                // Bind only within the same CLI: a pi session file must never
                // attach to an omp launch record even though they share a
                // transcript format.
                record.cli_tool == root.cli_tool
                    && record.resume_session_id.is_none()
                    && record.pty_session_id.is_some()
                    && record.runtime_kind.eq_ignore_ascii_case(runtime_kind)
                    && same_wsl_distro(record.wsl_distro.as_deref(), root.wsl_distro.as_deref())
                    && launch_record_matches_cwd(record, &cwd_norm)
                    && launch_time_matches(header_time, &record.launched_at)
            })
            .collect::<Vec<_>>();
        if candidates.len() != 1 {
            return;
        }
        let record_index = candidates[0].0;
        let Some(pty_session_id) = launch_records[record_index].pty_session_id.as_deref() else {
            return;
        };
        let pty_session_id = pty_session_id.to_string();

        // A session id may already have been bound by a concurrent scan or a
        // future Pi hook. Never move it across PTYs.
        match self
            .launch_history
            .find_by_resume_session_id(&parsed.session_id)
        {
            Ok(Some(existing))
                if existing.pty_session_id.as_deref() != Some(pty_session_id.as_str()) =>
            {
                return;
            }
            Ok(_) => {}
            Err(error) => {
                warn!(
                    session_id = %parsed.session_id,
                    err = %error,
                    "Failed to check existing Pi resume binding"
                );
                return;
            }
        }

        match self
            .launch_history
            .update_resume_session_with_source_by_pty_with_result(
                &pty_session_id,
                &parsed.session_id,
                "pi-session-file",
            ) {
            Ok(Some(selected)) => {
                let did_bind = selected.resume_session_id == parsed.session_id;
                let record = &mut launch_records[record_index];
                record.resume_session_id = Some(selected.resume_session_id.clone());
                record.resume_source = selected.resume_source.clone();
                if did_bind {
                    info!(
                        session_id = %parsed.session_id,
                        pty_session_id,
                        record_id = selected.record_id,
                        "Bound Pi session file to launch history"
                    );
                }
            }
            Ok(None) => {}
            Err(error) => warn!(
                session_id = %parsed.session_id,
                pty_session_id,
                err = %error,
                "Failed to bind Pi session file to launch history"
            ),
        }
    }

    fn resolve_identity(
        &self,
        session_id: &str,
        cwd: &str,
        registered: &[RegisteredProject],
        root: &ScanRoot,
    ) -> SessionIdentity {
        if let Ok(Some(record)) = self.launch_history.find_by_resume_session_id(session_id) {
            return SessionIdentity {
                project_path_norm: normalize_path(&record.project_path),
                project_name: record.project_name,
                workspace_name: record.workspace_name,
                wsl_distro: record.wsl_distro.or_else(|| root.wsl_distro.clone()),
            };
        }

        let cwd_norm = normalize_path(cwd);
        let matched = registered
            .iter()
            .filter(|project| path_has_prefix(&cwd_norm, &project.match_path_norm))
            .max_by_key(|project| project.match_path_norm.len());
        if let Some(project) = matched {
            return SessionIdentity {
                project_path_norm: project.project_path_norm.clone(),
                project_name: project.project_name.clone(),
                workspace_name: Some(project.workspace_name.clone()),
                wsl_distro: root
                    .wsl_distro
                    .clone()
                    .or_else(|| project.wsl_distro.clone()),
            };
        }
        SessionIdentity {
            project_path_norm: cwd_norm,
            project_name: path_name(cwd),
            workspace_name: None,
            wsl_distro: root.wsl_distro.clone(),
        }
    }
}

fn parse_rfc3339_utc(timestamp: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn launch_time_matches(header_time: DateTime<Utc>, launched_at: &str) -> bool {
    parse_rfc3339_utc(launched_at).is_some_and(|launch_time| {
        header_time
            .signed_duration_since(launch_time)
            .num_seconds()
            .abs()
            <= PI_RESUME_MATCH_WINDOW_SECS
    })
}

fn same_wsl_distro(record: Option<&str>, root: Option<&str>) -> bool {
    match (record, root) {
        (None, None) => true,
        (Some(record), Some(root)) => record.trim().eq_ignore_ascii_case(root.trim()),
        _ => false,
    }
}

fn launch_record_matches_cwd(record: &crate::repository::LaunchRecord, cwd_norm: &str) -> bool {
    [
        record.launch_cwd.as_deref(),
        record.workspace_path.as_deref(),
        Some(record.project_path.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(normalize_path)
    .any(|candidate| !candidate.is_empty() && candidate == cwd_norm)
}

fn modified_mtime_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn should_skip_file(state: Option<(i64, u64)>, mtime_ms: i64, size: u64) -> bool {
    state.is_some_and(|state| state == (mtime_ms, size))
}

#[cfg(test)]
mod tests {
    use super::{
        parse_session_transcript, should_skip_file, ScanRoot, SessionIndexScanReport,
        SessionIndexService,
    };
    use crate::repository::{Database, HistoryRepository, SessionIndexRepository};
    use crate::services::{LaunchHistoryService, WorkspaceService};
    use chrono::Utc;
    use std::fs;
    use std::sync::Arc;
    use tempfile::tempdir;

    #[test]
    fn parses_claude_fixture_message_count_cwd_prompts_and_last_summary() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("claude-session.jsonl");
        fs::write(
            &path,
            include_str!("../../tests/fixtures/session_index/claude.jsonl"),
        )
        .expect("write fixture");

        let parsed = parse_session_transcript("claude", &path).expect("parse claude");
        assert_eq!(parsed.session_id, "claude-session");
        assert_eq!(parsed.cwd, "/workspace/alpha");
        assert_eq!(parsed.first_prompt, "Investigate the session index");
        assert_eq!(parsed.last_summary, "The indexed result is ready");
        assert_eq!(parsed.message_count, 4);
    }

    #[test]
    fn parses_codex_fixture_message_count_meta_and_last_summary() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("rollout-session.jsonl");
        fs::write(
            &path,
            include_str!("../../tests/fixtures/session_index/codex.jsonl"),
        )
        .expect("write fixture");

        let parsed = parse_session_transcript("codex", &path).expect("parse codex");
        assert_eq!(parsed.session_id, "019f9550-2ba8-72e0-bb93-a41016243883");
        assert_eq!(parsed.cwd, "/workspace/beta");
        assert_eq!(parsed.first_prompt, "Build the indexed history view");
        assert_eq!(parsed.last_summary, "Session history is complete");
        assert_eq!(parsed.message_count, 4);
    }

    #[test]
    fn parses_pi_fixture_from_active_tree_branch() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("unrelated-name.jsonl");
        fs::write(
            &path,
            include_str!("../../tests/fixtures/session_index/pi.jsonl"),
        )
        .expect("write fixture");

        let parsed = parse_session_transcript("pi", &path).expect("parse Pi");
        assert_eq!(parsed.session_id, "pi-session-2026-08-18");
        assert_eq!(parsed.cwd, "/workspace/pi");
        assert_eq!(
            parsed.header_timestamp.as_deref(),
            Some("2026-08-18T00:00:00.000Z")
        );
        assert_eq!(parsed.first_prompt, "Build the Pi session index");
        assert_eq!(parsed.last_summary, "Current branch summary is ready");
        assert_eq!(parsed.message_count, 6);
    }

    #[test]
    fn unchanged_mtime_and_size_skip_body_io() {
        assert!(should_skip_file(Some((123, 456)), 123, 456));
        assert!(!should_skip_file(Some((123, 456)), 124, 456));
        assert!(!should_skip_file(Some((123, 456)), 123, 457));
        assert!(!should_skip_file(None, 123, 456));
    }

    #[test]
    fn second_scan_of_unchanged_file_reads_zero_transcript_bytes() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("claude-session.jsonl");
        fs::write(
            &path,
            include_str!("../../tests/fixtures/session_index/claude.jsonl"),
        )
        .expect("write fixture");
        let db = Arc::new(Database::new_in_memory().expect("db"));
        let repo = Arc::new(SessionIndexRepository::new(db.clone()));
        let service = SessionIndexService::new(
            repo,
            Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(
                db,
            )))),
            Arc::new(WorkspaceService::new(dir.path().join("workspaces"))),
        );
        let root = ScanRoot {
            cli_tool: "claude",
            path: dir.path().to_path_buf(),
            source: "local",
            wsl_distro: None,
        };

        let mut first = SessionIndexScanReport::default();
        service
            .scan_file(&root, &path, &[], &mut first)
            .expect("first scan");
        assert_eq!(first.files_parsed, 1);
        assert!(first.bytes_read > 0);

        let mut second = SessionIndexScanReport::default();
        service
            .scan_file(&root, &path, &[], &mut second)
            .expect("second scan");
        assert_eq!(second.files_skipped, 1);
        assert_eq!(second.files_parsed, 0);
        assert_eq!(second.bytes_read, 0);
    }

    #[test]
    fn pi_scan_binds_a_unique_matching_launch_record() {
        let dir = tempdir().expect("temp dir");
        let db = Arc::new(Database::new_in_memory().expect("db"));
        let history = Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(
            db.clone(),
        ))));
        history
            .add_with_pty_session(
                "pi-launch",
                "pi-project",
                "/workspace/pi",
                "pty-pi",
                "pi",
                "local",
                None,
                None,
                None,
                Some("/workspace/pi"),
                None,
                None,
                None,
                None,
                None,
            )
            .expect("seed Pi launch history");
        let service = SessionIndexService::new(
            Arc::new(SessionIndexRepository::new(db)),
            history.clone(),
            Arc::new(WorkspaceService::new(dir.path().join("workspaces"))),
        );
        let path = write_pi_session_file(dir.path(), "pi-unique", "/workspace/pi");
        let root = ScanRoot {
            cli_tool: "pi",
            path: dir.path().to_path_buf(),
            source: "local",
            wsl_distro: None,
        };

        service
            .scan_file(&root, &path, &[], &mut SessionIndexScanReport::default())
            .expect("scan Pi");

        let record = history
            .find_by_pty_session_id("pty-pi")
            .expect("find history")
            .expect("record exists");
        assert_eq!(record.resume_session_id.as_deref(), Some("pi-unique"));
        assert_eq!(record.resume_source.as_deref(), Some("pi-session-file"));
    }

    #[test]
    fn pi_scan_does_not_bind_an_ambiguous_launch_record() {
        let dir = tempdir().expect("temp dir");
        let db = Arc::new(Database::new_in_memory().expect("db"));
        let history = Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(
            db.clone(),
        ))));
        for (launch_id, pty_session_id) in [
            ("pi-launch-one", "pty-pi-one"),
            ("pi-launch-two", "pty-pi-two"),
        ] {
            history
                .add_with_pty_session(
                    launch_id,
                    "pi-project",
                    "/workspace/pi",
                    pty_session_id,
                    "pi",
                    "local",
                    None,
                    None,
                    None,
                    Some("/workspace/pi"),
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .expect("seed ambiguous Pi launch history");
        }
        let service = SessionIndexService::new(
            Arc::new(SessionIndexRepository::new(db)),
            history.clone(),
            Arc::new(WorkspaceService::new(dir.path().join("workspaces"))),
        );
        let path = write_pi_session_file(dir.path(), "pi-ambiguous", "/workspace/pi");
        let root = ScanRoot {
            cli_tool: "pi",
            path: dir.path().to_path_buf(),
            source: "local",
            wsl_distro: None,
        };

        service
            .scan_file(&root, &path, &[], &mut SessionIndexScanReport::default())
            .expect("scan Pi");

        for pty_session_id in ["pty-pi-one", "pty-pi-two"] {
            let record = history
                .find_by_pty_session_id(pty_session_id)
                .expect("find history")
                .expect("record exists");
            assert!(record.resume_session_id.is_none());
        }
    }

    fn write_pi_session_file(
        root: &std::path::Path,
        session_id: &str,
        cwd: &str,
    ) -> std::path::PathBuf {
        let path = root.join(format!("{session_id}.jsonl"));
        let header = serde_json::json!({
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": Utc::now().to_rfc3339(),
            "cwd": cwd,
        });
        let message = serde_json::json!({
            "type": "message",
            "id": "u0000001",
            "parentId": null,
            "timestamp": Utc::now().to_rfc3339(),
            "message": { "role": "user", "content": "index this Pi session" },
        });
        fs::write(&path, format!("{header}\n{message}\n")).expect("write Pi session");
        path
    }
}
