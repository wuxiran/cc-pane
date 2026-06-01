use crate::models::{
    UsageDayPoint, UsageEntry, UsageQueryResult, UsageStatsDelta, UsageTotals, WslDistro,
    WslDistroState,
};
use crate::repository::UsageStatsRepository;
use crate::services::{claude_session_service, codex_session_service, LaunchHistoryService};
use crate::utils::{error::AppError, AppResult};
use anyhow::{anyhow, Context, Result};
use chrono::{Duration as ChronoDuration, Local};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::time::{sleep, Duration};
use tracing::{error, info, warn};

const GLOBAL_WORKSPACE: &str = "_global";
const UNKNOWN_CLI: &str = "unknown";
const USAGE_SCAN_INTERVAL_SECS: u64 = 300;
const WSL_DISCOVERY_REFRESH_TICKS: u32 = 10;

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct UsageKey {
    date: String,
    cli_tool: String,
    workspace_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScanRoot {
    cli: &'static str,
    path: PathBuf,
    origin: ScanOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScanOrigin {
    Native,
    Wsl { distro: String },
}

pub struct UsageStatsService {
    repo: Arc<UsageStatsRepository>,
    launch_history: Arc<LaunchHistoryService>,
    pending_inputs: Mutex<HashMap<UsageKey, u64>>,
    wsl_distros: Mutex<Vec<WslDistro>>,
    background_started: AtomicBool,
    scan_running: AtomicBool,
}

impl UsageStatsService {
    pub fn new(repo: Arc<UsageStatsRepository>, launch_history: Arc<LaunchHistoryService>) -> Self {
        Self {
            repo,
            launch_history,
            pending_inputs: Mutex::new(HashMap::new()),
            wsl_distros: Mutex::new(Vec::new()),
            background_started: AtomicBool::new(false),
            scan_running: AtomicBool::new(false),
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
                warn!(err = %error, "Usage stats background tasks require a Tokio runtime");
                return;
            }
        };

        let flush_service = self.clone();
        handle.spawn(async move {
            loop {
                sleep(Duration::from_secs(30)).await;
                let svc = flush_service.clone();
                match tokio::task::spawn_blocking(move || svc.flush_pending()).await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => error!(err = %error, "Failed to flush usage input stats"),
                    Err(error) => error!(err = %error, "Usage input flush task failed"),
                }
            }
        });

        let scan_service = self.clone();
        handle.spawn(async move {
            scan_service.refresh_wsl_distros().await;
            scan_service.refresh_usage_stats_from_cache_logged();
            let mut tick = 0u32;
            loop {
                sleep(Duration::from_secs(USAGE_SCAN_INTERVAL_SECS)).await;
                tick = tick.wrapping_add(1);
                if tick.is_multiple_of(WSL_DISCOVERY_REFRESH_TICKS) {
                    scan_service.refresh_wsl_distros().await;
                }
                scan_service.refresh_usage_stats_from_cache_logged();
            }
        });
    }

    pub fn record_input(&self, session_id: &str, raw_text: &str) -> AppResult<()> {
        self.record_input_chars(session_id, count_input_chars(raw_text) as u32)
    }

    pub fn record_input_chars(&self, session_id: &str, char_count: u32) -> AppResult<()> {
        if char_count == 0 {
            return Ok(());
        }

        let (cli_tool, workspace_name) = self.resolve_pty_context(session_id);
        let key = UsageKey {
            date: today_string(),
            cli_tool,
            workspace_name,
        };
        let mut pending = self
            .pending_inputs
            .lock()
            .map_err(|_| AppError::from("Usage input accumulator lock poisoned"))?;
        *pending.entry(key).or_insert(0) += u64::from(char_count);
        Ok(())
    }

    pub fn flush_pending(&self) -> AppResult<()> {
        let pending = {
            let mut guard = self
                .pending_inputs
                .lock()
                .map_err(|_| AppError::from("Usage input accumulator lock poisoned"))?;
            std::mem::take(&mut *guard)
        };

        if pending.is_empty() {
            return Ok(());
        }

        let deltas = pending
            .into_iter()
            .map(|(key, char_count)| UsageStatsDelta {
                date: key.date,
                cli_tool: key.cli_tool,
                workspace_name: key.workspace_name,
                char_count,
                ..UsageStatsDelta::default()
            })
            .collect::<Vec<_>>();
        self.repo
            .upsert_pty_inputs(&deltas)
            .map_err(AppError::from)?;
        Ok(())
    }

    pub async fn refresh_usage_stats(self: Arc<Self>) -> AppResult<()> {
        self.refresh_wsl_distros().await;
        tokio::task::spawn_blocking(move || self.refresh_usage_stats_from_cache())
            .await
            .map_err(|e| AppError::from(e.to_string()))?
    }

    fn refresh_usage_stats_from_cache(&self) -> AppResult<()> {
        if self
            .scan_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }

        struct ScanGuard<'a>(&'a AtomicBool);
        impl Drop for ScanGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = ScanGuard(&self.scan_running);

        self.scan_all_usage_files().map_err(AppError::from)
    }

    pub fn query_usage(
        &self,
        range_days: u32,
        workspace_filter: Option<String>,
    ) -> AppResult<UsageQueryResult> {
        let range_days = range_days.clamp(1, 365);
        let today = Local::now().date_naive();
        let start = today - ChronoDuration::days(i64::from(range_days.saturating_sub(1)));
        let start_date = start.format("%Y-%m-%d").to_string();
        let workspace_filter = workspace_filter
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        let rows = self
            .repo
            .query_rows(&start_date, workspace_filter)
            .map_err(AppError::from)?;
        let mut days = BTreeMap::new();
        for offset in 0..range_days {
            let date = (start + ChronoDuration::days(i64::from(offset)))
                .format("%Y-%m-%d")
                .to_string();
            days.insert(
                date.clone(),
                UsageDayPoint {
                    date,
                    ..UsageDayPoint::default()
                },
            );
        }

        let mut totals = UsageTotals::default();
        let mut by_cli = HashMap::<String, UsageTotals>::new();
        for row in rows {
            totals.char_count += row.totals.char_count;
            totals.token_input += row.totals.token_input;
            totals.token_output += row.totals.token_output;
            totals.token_cache_read += row.totals.token_cache_read;
            totals.token_cache_creation += row.totals.token_cache_creation;
            let cli_totals = by_cli.entry(row.cli_tool.clone()).or_default();
            cli_totals.char_count += row.totals.char_count;
            cli_totals.token_input += row.totals.token_input;
            cli_totals.token_output += row.totals.token_output;
            cli_totals.token_cache_read += row.totals.token_cache_read;
            cli_totals.token_cache_creation += row.totals.token_cache_creation;

            if let Some(day) = days.get_mut(&row.date) {
                apply_row_to_day(day, &row.cli_tool, &row.totals);
            }
        }

        Ok(UsageQueryResult {
            series: days.into_values().collect(),
            totals,
            by_cli,
            workspaces: self.repo.list_workspaces().map_err(AppError::from)?,
        })
    }

    fn refresh_usage_stats_from_cache_logged(&self) {
        if let Err(error) = self.refresh_usage_stats_from_cache() {
            warn!(err = %error, "Usage stats refresh failed");
        }
    }

    async fn refresh_wsl_distros(&self) {
        #[cfg(target_os = "windows")]
        {
            match crate::services::wsl_discovery_service::discover(&[]).await {
                Ok(distros) => match self.wsl_distros.lock() {
                    Ok(mut guard) => {
                        *guard = distros;
                    }
                    Err(_) => warn!("Usage stats WSL distro cache lock poisoned"),
                },
                Err(error) => warn!(err = %error, "Failed to discover WSL distros for usage stats"),
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(mut guard) = self.wsl_distros.lock() {
                guard.clear();
            }
        }
    }

    fn scan_all_usage_files(&self) -> Result<()> {
        let wsl_distros = self
            .wsl_distros
            .lock()
            .map(|guard| guard.clone())
            .map_err(|_| anyhow!("Usage stats WSL distro cache lock poisoned"))?;
        for root in collect_scan_roots(&wsl_distros) {
            self.scan_root(&root);
        }
        Ok(())
    }

    fn scan_root(&self, root: &ScanRoot) {
        let paths = collect_jsonl_files(&root.path);
        info!(
            cli = root.cli,
            origin = ?root.origin,
            path = %root.path.display(),
            file_count = paths.len(),
            "Scanning usage stats root"
        );
        for path in paths {
            if let Err(error) = self.scan_file(root.cli, &path) {
                warn!(
                    cli = root.cli,
                    origin = ?root.origin,
                    path = %path.display(),
                    err = %error,
                    "Failed to scan usage file"
                );
            }
        }
    }

    fn scan_file(&self, cli_tool: &str, path: &Path) -> Result<()> {
        let path_string = path.to_string_lossy().to_string();
        let metadata = fs::metadata(path)
            .with_context(|| format!("Failed to read usage jsonl metadata: {}", path.display()))?;
        let len = metadata.len();
        let mtime_ms = modified_mtime_ms(&metadata);
        let state = self
            .repo
            .get_scan_state(&path_string)
            .map_err(|e| anyhow!(e))
            .with_context(|| format!("Failed to read scan state: {}", path.display()))?;

        // 优化：mtime + size 都没变 → 文件未动，跳过 IO
        if let Some(ref s) = state {
            if s.last_mtime_ms == mtime_ms && s.last_byte_offset == len {
                return Ok(());
            }
        }

        // 全文件重读 + REPLACE 该文件该 date 的累计行（幂等）。
        // 不再用增量 byte_offset，因为 REPLACE 语义要求 deltas 是"文件当前完整状态的聚合"。
        let (entries, _) = match cli_tool {
            "claude" => claude_session_service::read_session_usage(path, 0),
            "codex" => codex_session_service::read_session_usage(path, 0),
            _ => Ok((Vec::new(), 0)),
        }
        .map_err(|e| anyhow!(e))
        .with_context(|| format!("Failed to parse usage jsonl: {}", path.display()))?;

        // 先删该文件所有 date 行，再插新的 → 防止文件被截断/某 date 被删后 stale 数据残留
        self.repo
            .delete_jsonl_stats(&path_string)
            .map_err(|e| anyhow!(e))
            .context("Failed to clear previous usage stats for file")?;

        if !entries.is_empty() {
            let workspace = self.resolve_session_workspace(cli_tool, path);
            let deltas = aggregate_entries(cli_tool, &workspace, entries);
            self.repo
                .upsert_jsonl_stats_batch(&path_string, &deltas)
                .map_err(|e| anyhow!(e))
                .context("Failed to upsert usage stats")?;
        }

        // scan_state 现在只是 "mtime + size 缓存"，下次靠它跳过未变文件
        self.repo
            .upsert_scan_state(&path_string, len, mtime_ms)
            .map_err(|e| anyhow!(e))
            .context("Failed to update usage scan state")?;
        Ok(())
    }

    fn resolve_pty_context(&self, session_id: &str) -> (String, String) {
        match self.launch_history.find_by_pty_session_id(session_id) {
            Ok(Some(record)) => (
                normalize_cli(&record.cli_tool, UNKNOWN_CLI),
                normalize_workspace(record.workspace_name.as_deref()),
            ),
            Ok(None) => (UNKNOWN_CLI.to_string(), GLOBAL_WORKSPACE.to_string()),
            Err(error) => {
                warn!(session_id = %session_id, err = %error, "Failed to resolve usage pty context");
                (UNKNOWN_CLI.to_string(), GLOBAL_WORKSPACE.to_string())
            }
        }
    }

    fn resolve_session_workspace(&self, cli_tool: &str, path: &Path) -> String {
        let session_id = match session_id_for_path(cli_tool, path) {
            Some(session_id) => session_id,
            None => return GLOBAL_WORKSPACE.to_string(),
        };
        match self.launch_history.find_by_resume_session_id(&session_id) {
            Ok(Some(record)) => normalize_workspace(record.workspace_name.as_deref()),
            Ok(None) => GLOBAL_WORKSPACE.to_string(),
            Err(error) => {
                warn!(session_id = %session_id, err = %error, "Failed to resolve usage session workspace");
                GLOBAL_WORKSPACE.to_string()
            }
        }
    }
}

fn apply_row_to_day(day: &mut UsageDayPoint, cli_tool: &str, totals: &UsageTotals) {
    match cli_tool {
        "claude" => {
            day.claude_chars += totals.char_count;
            day.claude_tokens_in += totals.token_input;
            day.claude_tokens_out += totals.token_output;
            day.claude_cache_read += totals.token_cache_read;
            day.claude_cache_creation += totals.token_cache_creation;
        }
        "codex" => {
            day.codex_chars += totals.char_count;
            day.codex_tokens_in += totals.token_input;
            day.codex_tokens_out += totals.token_output;
            day.codex_cache_read += totals.token_cache_read;
            day.codex_cache_creation += totals.token_cache_creation;
        }
        _ => {
            day.unknown_chars += totals.char_count;
        }
    }
}

fn aggregate_entries(
    cli_tool: &str,
    workspace_name: &str,
    entries: Vec<UsageEntry>,
) -> Vec<UsageStatsDelta> {
    let mut by_date = HashMap::<String, UsageStatsDelta>::new();
    for entry in entries {
        let delta = by_date
            .entry(entry.date.clone())
            .or_insert_with(|| UsageStatsDelta {
                date: entry.date,
                cli_tool: cli_tool.to_string(),
                workspace_name: workspace_name.to_string(),
                ..UsageStatsDelta::default()
            });
        delta.token_input += entry.token_input;
        delta.token_output += entry.token_output;
        delta.token_cache_read += entry.token_cache_read;
        delta.token_cache_creation += entry.token_cache_creation;
    }
    by_date.into_values().collect()
}

fn collect_scan_roots(wsl_distros: &[WslDistro]) -> Vec<ScanRoot> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        collect_home_scan_roots(&home, ScanOrigin::Native, &mut roots);
    }

    for distro in wsl_distros {
        if distro.state != WslDistroState::Running {
            continue;
        }

        let distro_name = distro.name.trim();
        let Some(user) = distro
            .default_user
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if distro_name.is_empty() {
            continue;
        }

        let wsl_home = PathBuf::from(format!(r"\\wsl$\{}\home\{}", distro_name, user));
        collect_home_scan_roots(
            &wsl_home,
            ScanOrigin::Wsl {
                distro: distro_name.to_string(),
            },
            &mut roots,
        );
    }

    roots
}

fn collect_home_scan_roots(home: &Path, origin: ScanOrigin, roots: &mut Vec<ScanRoot>) {
    roots.push(ScanRoot {
        cli: "claude",
        path: home.join(".claude").join("projects"),
        origin: origin.clone(),
    });
    roots.push(ScanRoot {
        cli: "codex",
        path: home.join(".codex").join("sessions"),
        origin: origin.clone(),
    });
    collect_codex_home_scan_roots(home, origin, roots);
}

/// 扫描旧隔离目录（legacy）的会话作为用量统计来源。
///
/// 历史上 CC-Panes 把 Codex 关进 `~/.cache/cc-panes/codex-home/<sessionId>`，其 sessions
/// 子目录就是 `<sessionId>/sessions`（**不是** `<sessionId>/.codex/sessions`——原代码路径
/// 拼错导致一直扫不到）。现已去隔离、不再新建此目录，但旧目录里仍有历史 jsonl，保留扫描
/// 以免丢失既往用量统计。真实 `~/.codex/sessions` 已在 collect_scan_roots 中单独纳入。
fn collect_codex_home_scan_roots(home: &Path, origin: ScanOrigin, roots: &mut Vec<ScanRoot>) {
    let codex_home_root = home.join(".cache").join("cc-panes").join("codex-home");
    let Ok(entries) = fs::read_dir(codex_home_root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path().join("sessions");
        if path.is_dir() {
            roots.push(ScanRoot {
                cli: "codex",
                path,
                origin: origin.clone(),
            });
        }
    }
}

fn collect_jsonl_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_jsonl_files_inner(root, &mut files);
    files
}

fn collect_jsonl_files_inner(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files_inner(&path, files);
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

fn session_id_for_path(cli_tool: &str, path: &Path) -> Option<String> {
    match cli_tool {
        "codex" => codex_session_service::read_session_meta(path)
            .map(|(session_id, _)| session_id)
            .or_else(|| file_stem(path)),
        "claude" => file_stem(path),
        _ => None,
    }
}

fn file_stem(path: &Path) -> Option<String> {
    path.file_stem()
        .map(|value| value.to_string_lossy().to_string())
}

fn normalize_cli(cli_tool: &str, fallback: &str) -> String {
    let value = cli_tool.trim();
    if value.is_empty() || value == "none" {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn normalize_workspace(workspace_name: Option<&str>) -> String {
    workspace_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(GLOBAL_WORKSPACE)
        .to_string()
}

fn modified_mtime_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn today_string() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

pub fn count_input_chars(raw_text: &str) -> u64 {
    let mut count = 0;
    let mut chars = raw_text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if chars.peek() == Some(&'[') {
                let _ = chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }

        if should_count_input_char(ch) {
            count += 1;
        }
    }
    count
}

fn should_count_input_char(ch: char) -> bool {
    ch == '\t' || (ch >= ' ' && ch != '\u{7f}')
}

#[cfg(test)]
mod tests {
    use super::{collect_codex_home_scan_roots, collect_scan_roots, count_input_chars, ScanOrigin};
    use crate::models::{WslDistro, WslDistroState};
    use std::fs;

    fn wsl_distro(name: &str, state: WslDistroState, default_user: Option<&str>) -> WslDistro {
        WslDistro {
            name: name.to_string(),
            state,
            wsl_version: 2,
            is_default: false,
            default_user: default_user.map(str::to_string),
            already_imported: false,
        }
    }

    #[test]
    fn count_plain_ascii() {
        assert_eq!(count_input_chars("hello"), 5);
    }

    #[test]
    fn count_unicode_chars() {
        assert_eq!(count_input_chars("中文"), 2);
    }

    #[test]
    fn strip_ansi_sequences() {
        assert_eq!(count_input_chars("a\x1b[31mred\x1b[0m"), 4);
    }

    #[test]
    fn strip_control_chars_except_tab() {
        assert_eq!(count_input_chars("a\x03b"), 2);
        assert_eq!(count_input_chars("a\tb"), 3);
    }

    #[test]
    fn collect_scan_roots_windows_only() {
        let roots = collect_scan_roots(&[]);

        assert!(roots.len() >= 2);
        assert!(roots.iter().any(|root| root.cli == "claude"));
        assert!(roots.iter().any(|root| root.cli == "codex"));
        assert!(roots.iter().all(|root| root.origin == ScanOrigin::Native));
    }

    #[test]
    fn collect_scan_roots_with_wsl() {
        let roots = collect_scan_roots(&[
            wsl_distro("Ubuntu", WslDistroState::Running, Some("alice")),
            wsl_distro("NoUser", WslDistroState::Running, None),
        ]);

        assert!(roots.len() >= 4);
        let wsl_roots = roots
            .iter()
            .filter(|root| matches!(root.origin, ScanOrigin::Wsl { .. }))
            .collect::<Vec<_>>();
        assert_eq!(wsl_roots.len(), 2);
        assert!(wsl_roots.iter().any(|root| {
            let path = root.path.to_string_lossy().replace('\\', "/");
            root.cli == "claude"
                && path.contains("//wsl$/Ubuntu/home/alice")
                && path.contains(".claude/projects")
        }));
        assert!(wsl_roots.iter().any(|root| {
            let path = root.path.to_string_lossy().replace('\\', "/");
            root.cli == "codex"
                && path.contains("//wsl$/Ubuntu/home/alice")
                && path.contains(".codex/sessions")
        }));
    }

    #[test]
    fn collect_scan_roots_skips_stopped() {
        let roots =
            collect_scan_roots(&[wsl_distro("Ubuntu", WslDistroState::Stopped, Some("alice"))]);

        assert!(roots.len() >= 2);
        assert!(roots.iter().all(|root| root.origin == ScanOrigin::Native));
    }

    #[test]
    fn collect_codex_home_scan_roots_discovers_legacy_isolated_sessions() {
        let temp = tempfile::tempdir().expect("temp dir");
        // 旧隔离目录的真实结构：<sessionId>/sessions（不是 <sessionId>/.codex/sessions）。
        let sessions = temp
            .path()
            .join(".cache")
            .join("cc-panes")
            .join("codex-home")
            .join("session-123")
            .join("sessions");
        fs::create_dir_all(&sessions).expect("create isolated sessions dir");
        fs::create_dir_all(
            temp.path()
                .join(".cache")
                .join("cc-panes")
                .join("codex-home")
                .join("session-without-sessions"),
        )
        .expect("create unrelated isolated dir");

        let mut roots = Vec::new();
        collect_codex_home_scan_roots(temp.path(), ScanOrigin::Native, &mut roots);

        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].cli, "codex");
        assert_eq!(roots[0].path, sessions);
        assert_eq!(roots[0].origin, ScanOrigin::Native);
    }
}
