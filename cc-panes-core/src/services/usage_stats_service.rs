use crate::models::{
    ContextUsageSnapshot, ContextUsageStatus, UsageDayPoint, UsageEntry, UsageQueryResult,
    UsageStatsDelta, UsageTotals, WslDistro, WslDistroState,
};
use crate::repository::UsageStatsRepository;
use crate::services::{
    claude_session_service, codex_session_service, external_usage_session_service,
    LaunchHistoryService, ProviderService,
};
use crate::utils::{error::AppError, AppResult};
use anyhow::{anyhow, Context, Result};
use chrono::{Duration as ChronoDuration, Local};
use std::collections::{BTreeMap, HashMap, HashSet};
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
/// 统计算法版本。变更（如 Claude message.id 去重）时 +1：
/// 启动检测到版本不一致会清空 scan_state 强制全量重扫，历史聚合行被 REPLACE 重算。
const USAGE_SCAN_ALGO_VERSION: u64 = 3;
/// 版本号伪装成一条 scan_state 记录存储（jsonl_path 用 sentinel，不会与真实路径冲突）
const USAGE_SCAN_ALGO_VERSION_KEY: &str = "_algo_version";
const CONTEXT_USAGE_PARSER_VERSION: &str = "context-v1";
const CODEX_CONTEXT_BASELINE: u64 = 12_000;
const MAX_CONTEXT_SCAN_FILES: usize = 20_000;
/// 兜底上下文窗口大小。Provider DB 三层 lookup 全 miss 时返回这个值，让状态栏
/// `Ctx:` 段显示有效数字而非 `-%` / WINDOW_UNKNOWN。1M 贴近现代大模型上限
/// （Sonnet-4 / Opus-4.5 都是 1M），避免错把真实 1M 模型显示成「200k 半满」。
/// 仅对 claude 生效；codex 仍走 WINDOW_UNKNOWN 因为 `effective = window - 12_000`
/// 没有真实 window 不能硬编。
pub const DEFAULT_CLAUDE_CONTEXT_TOKENS: u64 = 1_000_000;

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
    source: UsageScanSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UsageScanSource {
    Jsonl,
    Gemini,
    OpenCode,
    GrokBuild,
}

struct ContextRequest {
    record: crate::repository::LaunchRecord,
    pty_session_id: String,
    cli: String,
    resume_id: String,
}

#[derive(Debug, Clone)]
struct ContextObservation {
    used_tokens: u64,
    window_tokens: Option<u64>,
    window_diagnostic: Option<String>,
    model: Option<String>,
}

/// `provider_window_for_request` 的解析结果。`ProviderModel` 命中 Provider DB
/// 时返回，window_source 标 `"provider-model"`；`DefaultFallback` 表示三层全
/// miss 走兜底常量，window_source 标 `"default-fallback:1m"`（或未来其他值）。
/// 区分这两个来源让诊断/排障仍能看出「用户没配」与「配了命中」的差别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowResolution {
    ProviderModel(u64),
    DefaultFallback(u64),
}

impl WindowResolution {
    fn tokens(self) -> u64 {
        match self {
            WindowResolution::ProviderModel(value) | WindowResolution::DefaultFallback(value) => {
                value
            }
        }
    }

    fn source_label(self) -> &'static str {
        match self {
            WindowResolution::ProviderModel(_) => "provider-model",
            // 与 `DEFAULT_CLAUDE_CONTEXT_TOKENS` 保持一致；常量改值时这里同步。
            WindowResolution::DefaultFallback(value) if value == DEFAULT_CLAUDE_CONTEXT_TOKENS => {
                "default-fallback:1m"
            }
            WindowResolution::DefaultFallback(_) => "default-fallback",
        }
    }
}

#[derive(Debug, Clone)]
struct ContextFileCache {
    path: PathBuf,
    resume_id: String,
    file_identity: (u64, u64),
    file_len: u64,
    modified_at_ms: i64,
    byte_offset: u64,
    observation: Option<ContextObservation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScanOrigin {
    Native,
    Wsl { distro: String },
}

pub struct UsageStatsService {
    repo: Arc<UsageStatsRepository>,
    launch_history: Arc<LaunchHistoryService>,
    provider_service: Option<Arc<ProviderService>>,
    pending_inputs: Mutex<HashMap<UsageKey, u64>>,
    wsl_distros: Mutex<Vec<WslDistro>>,
    background_started: AtomicBool,
    scan_running: AtomicBool,
    context_file_cache: Mutex<HashMap<String, ContextFileCache>>,
    context_reads: Mutex<HashSet<String>>,
    /// 供 WSL 扫描开关读取；None（测试等场景）视为未禁用
    settings: Option<Arc<crate::services::SettingsService>>,
    native_scan_home: Option<PathBuf>,
    allow_wsl_scan: bool,
    use_scan_environment_overrides: bool,
}

impl UsageStatsService {
    pub fn new(repo: Arc<UsageStatsRepository>, launch_history: Arc<LaunchHistoryService>) -> Self {
        Self::new_internal(
            repo,
            launch_history,
            None,
            None,
            dirs::home_dir(),
            true,
            true,
        )
    }

    pub fn new_with_provider(
        repo: Arc<UsageStatsRepository>,
        launch_history: Arc<LaunchHistoryService>,
        provider_service: Arc<ProviderService>,
    ) -> Self {
        Self::new_internal(
            repo,
            launch_history,
            Some(provider_service),
            None,
            dirs::home_dir(),
            true,
            true,
        )
    }

    fn new_internal(
        repo: Arc<UsageStatsRepository>,
        launch_history: Arc<LaunchHistoryService>,
        provider_service: Option<Arc<ProviderService>>,
        settings: Option<Arc<crate::services::SettingsService>>,
        native_scan_home: Option<PathBuf>,
        allow_wsl_scan: bool,
        use_scan_environment_overrides: bool,
    ) -> Self {
        Self {
            repo,
            launch_history,
            provider_service,
            pending_inputs: Mutex::new(HashMap::new()),
            wsl_distros: Mutex::new(Vec::new()),
            background_started: AtomicBool::new(false),
            scan_running: AtomicBool::new(false),
            context_file_cache: Mutex::new(HashMap::new()),
            context_reads: Mutex::new(HashSet::new()),
            settings,
            native_scan_home,
            allow_wsl_scan,
            use_scan_environment_overrides,
        }
    }

    pub fn new_with_settings(
        repo: Arc<UsageStatsRepository>,
        launch_history: Arc<LaunchHistoryService>,
        settings: Arc<crate::services::SettingsService>,
    ) -> Self {
        Self::new_internal(
            repo,
            launch_history,
            None,
            Some(settings),
            dirs::home_dir(),
            true,
            true,
        )
    }

    pub fn new_with_provider_and_settings(
        repo: Arc<UsageStatsRepository>,
        launch_history: Arc<LaunchHistoryService>,
        provider_service: Arc<ProviderService>,
        settings: Arc<crate::services::SettingsService>,
    ) -> Self {
        Self::new_internal(
            repo,
            launch_history,
            Some(provider_service),
            Some(settings),
            dirs::home_dir(),
            true,
            true,
        )
    }

    /// Build a deterministic scanner that never reads the process user's real
    /// CLI caches or discovers WSL distributions.
    pub fn new_with_isolated_scan_home(
        repo: Arc<UsageStatsRepository>,
        launch_history: Arc<LaunchHistoryService>,
        native_scan_home: PathBuf,
    ) -> Self {
        Self::new_internal(
            repo,
            launch_history,
            None,
            None,
            Some(native_scan_home),
            false,
            false,
        )
    }

    /// WSL 扫描是否被设置禁用
    fn wsl_scan_disabled(&self) -> bool {
        self.settings
            .as_ref()
            .is_some_and(|settings| settings.get_settings().general.disable_wsl_usage_scan)
    }

    /// WSL 扫描门控：设置未禁用 且 WSL VM 本来就在运行。
    /// 探测零副作用（只查 vmmem 进程），保证"单纯启动 app 绝不唤醒 WSL"。
    fn wsl_scan_allowed(&self) -> bool {
        self.allow_wsl_scan
            && !self.wsl_scan_disabled()
            && crate::services::wsl_discovery_service::is_wsl_vm_running()
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
            scan_service.ensure_scan_algo_version();
            // 启动首扫只扫本机：不做 WSL discovery，保证"单纯启动 app 不唤醒 WSL"
            // （issue #37：\\wsl$ 访问与 wsl.exe 调用会拉起/保活 Vmmem VM）。
            scan_service.refresh_usage_stats_from_cache_logged();
            let mut tick = 0u32;
            loop {
                sleep(Duration::from_secs(USAGE_SCAN_INTERVAL_SECS)).await;
                tick = tick.wrapping_add(1);
                // 缓存为空且 WSL 已在跑时提前 discovery，WSL 用户最多等一个
                // 扫描周期统计就能跟上，不必等满 10 tick。
                let cache_empty = scan_service
                    .wsl_distros
                    .lock()
                    .map(|guard| guard.is_empty())
                    .unwrap_or(false);
                if tick.is_multiple_of(WSL_DISCOVERY_REFRESH_TICKS) || cache_empty {
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

    /// Resolve and parse the latest context observation for one managed PTY session.
    /// This intentionally does not use the historical usage aggregate.
    pub fn context_usage_for_pty(&self, pty_session_id: &str) -> ContextUsageSnapshot {
        let acquired = self
            .context_reads
            .lock()
            .map(|mut reads| reads.insert(pty_session_id.to_string()))
            .unwrap_or(false);
        if !acquired {
            return ContextUsageSnapshot::error("SOURCE_UNAVAILABLE", now_millis());
        }
        let result = self.context_usage_for_pty_uncached(pty_session_id);
        if let Ok(mut reads) = self.context_reads.lock() {
            reads.remove(pty_session_id);
        }
        result
    }

    fn context_usage_for_pty_uncached(&self, pty_session_id: &str) -> ContextUsageSnapshot {
        let observed_at = now_millis();
        let request = match self.context_request(pty_session_id, observed_at) {
            Ok(request) => request,
            Err(snapshot) => return *snapshot,
        };
        let path = self
            .cached_context_path(&request.pty_session_id, &request.resume_id)
            .filter(|path| path.is_file())
            .or_else(|| {
                find_context_session_file(self, &request.cli, &request.record, &request.resume_id)
            });
        let Some(path) = path else {
            return ContextUsageSnapshot::error("SESSION_NOT_FOUND", observed_at);
        };
        self.read_context_snapshot(&request, &path, observed_at)
    }

    fn context_request(
        &self,
        pty_session_id: &str,
        observed_at: i64,
    ) -> Result<ContextRequest, Box<ContextUsageSnapshot>> {
        if !valid_context_session_id(pty_session_id) {
            return Err(Box::new(ContextUsageSnapshot::error(
                "SESSION_NOT_FOUND",
                observed_at,
            )));
        }
        let record = match self.launch_history.find_by_pty_session_id(pty_session_id) {
            Ok(Some(record)) => record,
            Ok(None) => {
                return Err(Box::new(ContextUsageSnapshot::error(
                    "SESSION_NOT_FOUND",
                    observed_at,
                )))
            }
            Err(error) => {
                warn!(pty_session_id = %pty_session_id, err = %error, "Failed to resolve context launch history");
                return Err(Box::new(ContextUsageSnapshot::error(
                    "SOURCE_UNAVAILABLE",
                    observed_at,
                )));
            }
        };
        let cli = record.cli_tool.trim().to_ascii_lowercase();
        if !matches!(cli.as_str(), "claude" | "codex")
            || record.runtime_kind.eq_ignore_ascii_case("ssh")
        {
            return Err(Box::new(ContextUsageSnapshot::error(
                "RUNTIME_UNSUPPORTED",
                observed_at,
            )));
        }
        let Some(resume_id) = record
            .resume_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "new")
            .map(str::to_owned)
        else {
            return Err(Box::new(ContextUsageSnapshot::waiting(
                "WAITING_FIRST_RESPONSE",
                observed_at,
            )));
        };
        if !valid_context_session_id(&resume_id) {
            return Err(Box::new(ContextUsageSnapshot::error(
                "SESSION_NOT_FOUND",
                observed_at,
            )));
        }
        if record.runtime_kind.eq_ignore_ascii_case("wsl") && !self.wsl_scan_allowed() {
            return Err(Box::new(ContextUsageSnapshot::error(
                "SOURCE_UNAVAILABLE",
                observed_at,
            )));
        }
        Ok(ContextRequest {
            record,
            pty_session_id: pty_session_id.to_string(),
            cli,
            resume_id,
        })
    }

    fn cached_context_path(&self, pty_session_id: &str, resume_id: &str) -> Option<PathBuf> {
        self.context_file_cache.lock().ok().and_then(|cache| {
            cache
                .get(pty_session_id)
                .and_then(|entry| (entry.resume_id == resume_id).then(|| entry.path.clone()))
        })
    }

    fn read_context_snapshot(
        &self,
        request: &ContextRequest,
        path: &Path,
        observed_at: i64,
    ) -> ContextUsageSnapshot {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => {
                warn!(path = %path.display(), err = %error, "Failed to read context usage metadata");
                return ContextUsageSnapshot::error("SOURCE_UNAVAILABLE", observed_at);
            }
        };
        let file_len = metadata.len();
        let modified_at_ms = modified_mtime_ms(&metadata);
        let file_identity = file_identity(&metadata);
        let cached = self
            .context_file_cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(&request.pty_session_id).cloned());
        if let Some(entry) = cached.as_ref().filter(|entry| {
            entry.path == path
                && entry.resume_id == request.resume_id
                && entry.file_identity == file_identity
                && entry.file_len == file_len
                && entry.modified_at_ms == modified_at_ms
        }) {
            return self.context_observation_snapshot(
                request,
                entry.observation.as_ref(),
                observed_at,
            );
        }
        let from_offset = cached
            .as_ref()
            .filter(|entry| {
                entry.path == path
                    && entry.resume_id == request.resume_id
                    && entry.file_identity == file_identity
                    && entry.file_len <= file_len
                    && modified_at_ms >= entry.modified_at_ms
            })
            .map(|entry| entry.byte_offset)
            .unwrap_or(0);
        let parsed = match request.cli.as_str() {
            "claude" => claude_session_service::read_latest_context_usage(path, from_offset).map(
                |(latest, offset)| {
                    (
                        latest.map(|value| ContextObservation {
                            used_tokens: value
                                .usage
                                .token_input
                                .saturating_add(value.usage.token_cache_read)
                                .saturating_add(value.usage.token_cache_creation),
                            window_tokens: value.window_tokens,
                            window_diagnostic: value.window_diagnostic,
                            model: value.model,
                        }),
                        offset,
                    )
                },
            ),
            "codex" => codex_session_service::read_latest_context_usage(path, from_offset).map(
                |(latest, offset)| {
                    (
                        latest.and_then(|value| {
                            value.total_tokens.map(|used_tokens| ContextObservation {
                                used_tokens,
                                window_tokens: value.window_tokens,
                                window_diagnostic: value.window_diagnostic,
                                model: value.model,
                            })
                        }),
                        offset,
                    )
                },
            ),
            _ => Err("unsupported CLI".to_string()),
        };
        let (new_observation, byte_offset) = match parsed {
            Ok(value) => value,
            Err(error) => {
                warn!(path = %path.display(), err = %error, "Failed to read context usage");
                return ContextUsageSnapshot::error("SOURCE_UNAVAILABLE", observed_at);
            }
        };
        let observation = new_observation.or_else(|| cached.and_then(|entry| entry.observation));
        if let Ok(mut cache) = self.context_file_cache.lock() {
            cache.insert(
                request.pty_session_id.clone(),
                ContextFileCache {
                    path: path.to_path_buf(),
                    resume_id: request.resume_id.clone(),
                    file_identity,
                    file_len,
                    modified_at_ms,
                    byte_offset,
                    observation: observation.clone(),
                },
            );
        }
        self.context_observation_snapshot(request, observation.as_ref(), observed_at)
    }

    fn refresh_usage_stats_from_cache_logged(&self) {
        if let Err(error) = self.refresh_usage_stats_from_cache() {
            warn!(err = %error, "Usage stats refresh failed");
        }
    }

    async fn refresh_wsl_distros(&self) {
        #[cfg(target_os = "windows")]
        {
            // 门控：设置禁用或 WSL VM 没在跑时不执行 wsl.exe（--list --verbose 会拉起
            // wslservice），并清空缓存防止 stale Running 条目触发 \\wsl$ 扫描。
            if !self.wsl_scan_allowed() {
                if let Ok(mut guard) = self.wsl_distros.lock() {
                    guard.clear();
                }
                return;
            }
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

    /// 统计算法版本门：版本变更时清空 scan_state，强制全量重扫重算历史聚合。
    fn ensure_scan_algo_version(&self) {
        match self.repo.get_scan_state(USAGE_SCAN_ALGO_VERSION_KEY) {
            Ok(Some(state)) if state.last_byte_offset == USAGE_SCAN_ALGO_VERSION => {}
            Ok(_) => {
                info!(
                    version = USAGE_SCAN_ALGO_VERSION,
                    "Usage scan algorithm changed; forcing full rescan"
                );
                if let Err(error) = self.repo.clear_all_scan_states() {
                    warn!(err = %error, "Failed to clear usage scan states for algo upgrade");
                    return;
                }
                if let Err(error) = self.repo.upsert_scan_state(
                    USAGE_SCAN_ALGO_VERSION_KEY,
                    USAGE_SCAN_ALGO_VERSION,
                    0,
                ) {
                    warn!(err = %error, "Failed to record usage scan algo version");
                }
            }
            Err(error) => warn!(err = %error, "Failed to read usage scan algo version"),
        }
    }

    fn scan_all_usage_files(&self) -> Result<()> {
        let wsl_distros = self
            .wsl_distros
            .lock()
            .map(|guard| guard.clone())
            .map_err(|_| anyhow!("Usage stats WSL distro cache lock poisoned"))?;
        // 扫描前实时复核：discovery 缓存最长 50 分钟，期间 WSL 可能已被用户关掉；
        // 若仍按缓存访问 \\wsl$ 会把已停止的 distro 重新唤醒（issue #37 的冷唤醒源）。
        let wsl_vm_running = self.wsl_scan_allowed();
        for root in collect_scan_roots_from_home(
            self.native_scan_home.as_deref(),
            &wsl_distros,
            wsl_vm_running,
            self.use_scan_environment_overrides,
        ) {
            self.scan_root(&root);
        }
        Ok(())
    }

    fn scan_root(&self, root: &ScanRoot) {
        let paths = match root.source {
            UsageScanSource::Jsonl => collect_jsonl_files(&root.path),
            UsageScanSource::Gemini => {
                external_usage_session_service::collect_gemini_session_files(&root.path)
            }
            UsageScanSource::OpenCode => vec![root.path.clone()],
            UsageScanSource::GrokBuild => {
                external_usage_session_service::collect_grok_usage_files(&root.path)
            }
        };
        info!(
            cli = root.cli,
            origin = ?root.origin,
            path = %root.path.display(),
            file_count = paths.len(),
            "Scanning usage stats root"
        );
        for path in paths {
            if !path.is_file() {
                continue;
            }
            if let Err(error) = self.scan_file(root.cli, root.source, &path) {
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

    fn scan_file(&self, cli_tool: &str, source: UsageScanSource, path: &Path) -> Result<()> {
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
        let entries =
            match source {
                UsageScanSource::Jsonl => match cli_tool {
                    "claude" => claude_session_service::read_session_usage(path, 0)
                        .map(|(entries, _)| entries),
                    "codex" => codex_session_service::read_session_usage(path, 0)
                        .map(|(entries, _)| entries),
                    _ => Ok(Vec::new()),
                },
                UsageScanSource::Gemini => {
                    external_usage_session_service::read_gemini_session_usage(path)
                }
                UsageScanSource::OpenCode => {
                    external_usage_session_service::read_opencode_session_usage(path)
                }
                UsageScanSource::GrokBuild => {
                    external_usage_session_service::read_grok_session_usage(path)
                }
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

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis().max(0)
}

fn valid_context_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

#[cfg(test)]
fn ready_claude_snapshot(
    resume_id: &str,
    usage: UsageEntry,
    window_tokens: u64,
    model: Option<String>,
    observed_at: i64,
) -> ContextUsageSnapshot {
    let used = usage
        .token_input
        .saturating_add(usage.token_cache_read)
        .saturating_add(usage.token_cache_creation);
    ready_snapshot(
        resume_id,
        used,
        used,
        window_tokens,
        window_tokens,
        model,
        "claude-jsonl",
        "claude-jsonl",
        observed_at,
    )
}

#[cfg(test)]
fn ready_codex_snapshot(
    resume_id: &str,
    _usage: UsageEntry,
    total_tokens: Option<u64>,
    window_tokens: Option<u64>,
    model: Option<String>,
    observed_at: i64,
) -> ContextUsageSnapshot {
    let Some(window) = window_tokens else {
        return unknown_window_snapshot(
            resume_id,
            total_tokens.unwrap_or(0),
            model,
            "codex-jsonl",
            observed_at,
        );
    };
    let Some(raw_used) = total_tokens else {
        return ContextUsageSnapshot::error("USAGE_INVALID", observed_at);
    };
    let Some(effective_window) = window.checked_sub(CODEX_CONTEXT_BASELINE) else {
        return unknown_window_snapshot(resume_id, raw_used, model, "codex-jsonl", observed_at);
    };
    if effective_window == 0 {
        return unknown_window_snapshot(resume_id, raw_used, model, "codex-jsonl", observed_at);
    }
    let effective_used = raw_used.saturating_sub(CODEX_CONTEXT_BASELINE);
    ready_snapshot(
        resume_id,
        raw_used,
        effective_used,
        window,
        effective_window,
        model,
        "codex-jsonl",
        "codex-jsonl",
        observed_at,
    )
}

impl UsageStatsService {
    /// Provider 解析结果。`DefaultFallback` 与 `ProviderModel` 区分开以便
    /// `window_source` 字段精确标识走的是 Provider DB 还是兜底常量（前端诊断
    /// 仍能区分「配了 1M」与「啥都没配默认 1M」）。
    fn provider_window_for_request(
        &self,
        request: &ContextRequest,
        observed_model: Option<&str>,
    ) -> Option<WindowResolution> {
        let provider_service = self.provider_service.as_ref()?;
        let provider_id = request
            .record
            .provider_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let requested_model_id = request
            .record
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());

        if let Some(provider) = match provider_id {
            Some(provider_id) => provider_service.get_provider(provider_id),
            None => provider_service.get_default_provider_for_cli(&request.cli),
        } {
            let model_id = requested_model_id.map(str::to_owned).or_else(|| {
                provider
                    .default_model_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
            });
            if let Some(model_id) = model_id {
                if let Some(matched) = provider
                    .models
                    .into_iter()
                    .find(|model| model.id.trim() == model_id)
                {
                    // 优先 context_window_tokens（数字形式，已 token 计）；
                    // fallback context_size（字符串形式，如 "1m"/"500k"）经 parse_context_size_tokens
                    // 反解——与 ccpanel 行为对齐。
                    if let Some(window) = matched.context_window_tokens {
                        return Some(WindowResolution::ProviderModel(window));
                    }
                    if let Some(size) = matched.context_size.as_deref() {
                        let tokens = crate::utils::parse_context_size_tokens(size);
                        if tokens > 0 {
                            return Some(WindowResolution::ProviderModel(tokens));
                        }
                    }
                }
            }
        }

        // A restored launch can have stale or incomplete provider metadata in
        // launch_history. The CLI's observed model is authoritative for the
        // response, so use it to find the configured context window globally.
        if let Some(observed_model) = observed_model.map(str::trim) {
            if !observed_model.is_empty() {
                // 第一层：observed model 自带 `[<size>]` 后缀时（注入 `ANTHROPIC_MODEL`
                // 拼了 `[1m]` 就会这样），直接反解拿 token 数——这与 ccpanel
                // `parse_context_window_from_model` 同源。
                let from_suffix = crate::utils::parse_context_window_from_model(observed_model);
                if from_suffix > 0 {
                    return Some(WindowResolution::ProviderModel(from_suffix));
                }
                // 第二层：observed model 名在所有 Provider 的 model.id 里能命中
                // （先看 context_window_tokens，再看 context_size）。
                if let Some(matched) = provider_service
                    .list_providers()
                    .into_iter()
                    .flat_map(|provider| provider.models)
                    .find(|model| model.id.trim().eq_ignore_ascii_case(observed_model))
                {
                    if let Some(window) = matched.context_window_tokens {
                        return Some(WindowResolution::ProviderModel(window));
                    }
                    if let Some(size) = matched.context_size.as_deref() {
                        let tokens = crate::utils::parse_context_size_tokens(size);
                        if tokens > 0 {
                            return Some(WindowResolution::ProviderModel(tokens));
                        }
                    }
                }
            }
        }

        // 兜底：三层 lookup 全 miss 时给个保守值，让状态栏仍能显示百分比。
        // 仅对 claude 生效（codex 需要 `effective = window - 12_000`，没有真实
        // window 不能硬编，会走原 WINDOW_UNKNOWN 路径）。
        if request.cli == "claude" {
            return Some(WindowResolution::DefaultFallback(
                DEFAULT_CLAUDE_CONTEXT_TOKENS,
            ));
        }
        None
    }

    fn context_observation_snapshot(
        &self,
        request: &ContextRequest,
        observation: Option<&ContextObservation>,
        observed_at: i64,
    ) -> ContextUsageSnapshot {
        let Some(observation) = observation else {
            return ContextUsageSnapshot::waiting("WAITING_FIRST_RESPONSE", observed_at);
        };
        match request.cli.as_str() {
            "claude" => with_window_diagnostic(
                if let Some(window) = observation.window_tokens {
                    ready_snapshot(
                        &request.resume_id,
                        observation.used_tokens,
                        observation.used_tokens,
                        window,
                        window,
                        observation.model.clone(),
                        "claude-jsonl",
                        "claude-jsonl",
                        observed_at,
                    )
                } else {
                    match self.provider_window_for_request(request, observation.model.as_deref()) {
                        Some(resolution) => {
                            let window = resolution.tokens();
                            ready_snapshot(
                                &request.resume_id,
                                observation.used_tokens,
                                observation.used_tokens,
                                window,
                                window,
                                observation.model.clone(),
                                "claude-jsonl",
                                resolution.source_label(),
                                observed_at,
                            )
                        }
                        None => unknown_window_snapshot(
                            &request.resume_id,
                            observation.used_tokens,
                            observation.model.clone(),
                            "claude-jsonl",
                            observed_at,
                        ),
                    }
                },
                observation.window_diagnostic.as_deref(),
            ),
            "codex" => {
                let (window, window_source) = match observation.window_tokens {
                    Some(window) => (Some(window), "codex-jsonl"),
                    None => match self
                        .provider_window_for_request(request, observation.model.as_deref())
                    {
                        Some(resolution) => (Some(resolution.tokens()), resolution.source_label()),
                        None => (None, "unknown"),
                    },
                };
                let effective_window = window.and_then(|window| {
                    window
                        .checked_sub(CODEX_CONTEXT_BASELINE)
                        .filter(|effective| *effective > 0)
                        .map(|effective| (window, effective))
                });
                with_window_diagnostic(
                    if let Some((window, effective_window)) = effective_window {
                        ready_snapshot(
                            &request.resume_id,
                            observation.used_tokens,
                            observation
                                .used_tokens
                                .saturating_sub(CODEX_CONTEXT_BASELINE),
                            window,
                            effective_window,
                            observation.model.clone(),
                            "codex-jsonl",
                            window_source,
                            observed_at,
                        )
                    } else {
                        unknown_window_snapshot(
                            &request.resume_id,
                            observation.used_tokens,
                            observation.model.clone(),
                            "codex-jsonl",
                            observed_at,
                        )
                    },
                    observation.window_diagnostic.as_deref(),
                )
            }
            _ => ContextUsageSnapshot::error("RUNTIME_UNSUPPORTED", observed_at),
        }
    }
}

fn with_window_diagnostic(
    mut snapshot: ContextUsageSnapshot,
    diagnostic_code: Option<&str>,
) -> ContextUsageSnapshot {
    if let Some(diagnostic_code) = diagnostic_code {
        snapshot.diagnostic_code = Some(diagnostic_code.to_string());
    }
    snapshot
}

fn unknown_window_snapshot(
    resume_id: &str,
    used_tokens: u64,
    model: Option<String>,
    usage_source: &str,
    observed_at: i64,
) -> ContextUsageSnapshot {
    ContextUsageSnapshot {
        status: ContextUsageStatus::Ready,
        used_tokens: Some(used_tokens),
        effective_used_tokens: Some(used_tokens),
        window_tokens: None,
        effective_window_tokens: None,
        used_percentage: None,
        remaining_percentage: None,
        model,
        usage_source: Some(usage_source.to_string()),
        window_source: Some("unknown".to_string()),
        agent_session_id: Some(resume_id.to_string()),
        parser_version: Some(CONTEXT_USAGE_PARSER_VERSION.to_string()),
        observed_at,
        diagnostic_code: Some("WINDOW_UNKNOWN".to_string()),
    }
}

#[allow(clippy::too_many_arguments)]
fn ready_snapshot(
    resume_id: &str,
    used: u64,
    effective_used: u64,
    window: u64,
    effective_window: u64,
    model: Option<String>,
    usage_source: &str,
    window_source: &str,
    observed_at: i64,
) -> ContextUsageSnapshot {
    let percent = effective_used
        .checked_mul(100)
        .and_then(|value| value.checked_add(effective_window / 2))
        .map(|value| (value / effective_window).min(100) as u8);
    ContextUsageSnapshot {
        status: ContextUsageStatus::Ready,
        used_tokens: Some(used),
        effective_used_tokens: Some(effective_used),
        window_tokens: Some(window),
        effective_window_tokens: Some(effective_window),
        used_percentage: percent,
        remaining_percentage: percent.map(|value| 100u8.saturating_sub(value)),
        model,
        usage_source: Some(usage_source.to_string()),
        window_source: Some(window_source.to_string()),
        agent_session_id: Some(resume_id.to_string()),
        parser_version: Some(CONTEXT_USAGE_PARSER_VERSION.to_string()),
        observed_at,
        diagnostic_code: None,
    }
}

fn find_context_session_file(
    service: &UsageStatsService,
    cli: &str,
    record: &crate::repository::LaunchRecord,
    resume_id: &str,
) -> Option<PathBuf> {
    let roots = context_session_roots(service, cli, record);
    for root in roots {
        let mut files = Vec::new();
        collect_jsonl_files_limited(&root, &mut files, MAX_CONTEXT_SCAN_FILES);
        for path in files {
            if cli == "claude"
                && path.file_stem().and_then(|value| value.to_str()) == Some(resume_id)
            {
                return Some(path);
            }
            if cli == "codex" {
                if path.file_stem().and_then(|value| value.to_str()) == Some(resume_id) {
                    return Some(path);
                }
                if codex_session_service::read_session_meta(&path)
                    .is_some_and(|(session_id, _)| session_id == resume_id)
                {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn context_session_roots(
    service: &UsageStatsService,
    cli: &str,
    record: &crate::repository::LaunchRecord,
) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    if record.runtime_kind.eq_ignore_ascii_case("wsl") {
        let distro = record
            .wsl_distro
            .as_deref()
            .map(str::trim)
            .unwrap_or_default();
        let cwd = record.launch_cwd.as_deref().unwrap_or(&record.project_path);
        let cached_default_user = service.wsl_distros.lock().ok().and_then(|distros| {
            distros
                .iter()
                .find(|entry| entry.name.eq_ignore_ascii_case(distro))
                .and_then(|entry| entry.default_user.clone())
        });
        if let Some(wsl_home) = wsl_home_from_cwd(distro, cwd)
            .or_else(|| wsl_home_from_user(distro, cached_default_user.as_deref()))
        {
            return vec![match cli {
                "claude" => wsl_home.join(".claude").join("projects"),
                "codex" => wsl_home.join(".codex").join("sessions"),
                _ => return Vec::new(),
            }];
        }
        return Vec::new();
    }
    vec![match cli {
        "claude" => home.join(".claude").join("projects"),
        "codex" => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
            .join("sessions"),
        _ => return Vec::new(),
    }]
}

fn wsl_home_from_cwd(distro: &str, cwd: &str) -> Option<PathBuf> {
    if !valid_wsl_distro(distro) {
        return None;
    }
    let normalized = cwd.replace('\\', "/");
    let home_user = normalized
        .strip_prefix("/home/")
        .and_then(|value| value.split('/').next())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let lower = normalized.to_ascii_lowercase();
            let marker = format!("//wsl.localhost/{}/home/", distro.to_ascii_lowercase());
            let start = lower.strip_prefix(&marker)?;
            let offset = normalized.len() - start.len();
            normalized[offset..]
                .split('/')
                .next()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })?;
    if !valid_context_session_id(&home_user) {
        return None;
    }
    Some(PathBuf::from(format!(
        r"\\wsl$\{}\home\{}",
        distro, home_user
    )))
}

fn wsl_home_from_user(distro: &str, user: Option<&str>) -> Option<PathBuf> {
    let user = user?.trim();
    if !valid_wsl_distro(distro) || !valid_context_session_id(user) {
        return None;
    }
    let home = if user.eq_ignore_ascii_case("root") {
        format!(r"\\wsl$\{}\root", distro)
    } else {
        format!(r"\\wsl$\{}\home\{}", distro, user)
    };
    Some(PathBuf::from(home))
}

fn valid_wsl_distro(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn collect_jsonl_files_limited(root: &Path, files: &mut Vec<PathBuf>, limit: usize) {
    let Ok(root) = fs::canonicalize(root) else {
        return;
    };
    collect_jsonl_files_limited_inner(&root, &root, files, limit);
}

fn collect_jsonl_files_limited_inner(
    root: &Path,
    allowed_root: &Path,
    files: &mut Vec<PathBuf>,
    limit: usize,
) {
    if files.len() >= limit {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if files.len() >= limit {
            break;
        }
        let path = match fs::canonicalize(entry.path()) {
            Ok(path) if path.starts_with(allowed_root) => path,
            _ => continue,
        };
        if path.is_dir() {
            collect_jsonl_files_limited_inner(&path, allowed_root, files, limit);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

fn apply_row_to_day(day: &mut UsageDayPoint, cli_tool: &str, totals: &UsageTotals) {
    let by_cli = day.by_cli.entry(cli_tool.to_string()).or_default();
    by_cli.char_count += totals.char_count;
    by_cli.token_input += totals.token_input;
    by_cli.token_output += totals.token_output;
    by_cli.token_cache_read += totals.token_cache_read;
    by_cli.token_cache_creation += totals.token_cache_creation;

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

#[cfg(test)]
fn collect_scan_roots(wsl_distros: &[WslDistro], wsl_vm_running: bool) -> Vec<ScanRoot> {
    collect_scan_roots_from_home(
        dirs::home_dir().as_deref(),
        wsl_distros,
        wsl_vm_running,
        true,
    )
}

fn collect_scan_roots_from_home(
    native_home: Option<&Path>,
    wsl_distros: &[WslDistro],
    wsl_vm_running: bool,
    use_native_environment_overrides: bool,
) -> Vec<ScanRoot> {
    let mut roots = Vec::new();
    if let Some(home) = native_home {
        collect_home_scan_roots(
            home,
            ScanOrigin::Native,
            use_native_environment_overrides,
            &mut roots,
        );
    }

    // VM 已不在跑时忽略缓存里的 Running 条目：访问 \\wsl$ 会重新唤醒 distro
    if !wsl_vm_running {
        return roots;
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
            false,
            &mut roots,
        );
    }

    roots
}

fn collect_home_scan_roots(
    home: &Path,
    origin: ScanOrigin,
    use_environment_overrides: bool,
    roots: &mut Vec<ScanRoot>,
) {
    roots.push(ScanRoot {
        cli: "claude",
        path: home.join(".claude").join("projects"),
        origin: origin.clone(),
        source: UsageScanSource::Jsonl,
    });
    roots.push(ScanRoot {
        cli: "codex",
        path: home.join(".codex").join("sessions"),
        origin: origin.clone(),
        source: UsageScanSource::Jsonl,
    });
    roots.push(ScanRoot {
        cli: "gemini",
        path: home.join(".gemini"),
        origin: origin.clone(),
        source: UsageScanSource::Gemini,
    });
    roots.push(ScanRoot {
        cli: "opencode",
        path: external_usage_session_service::opencode_db_path(home, use_environment_overrides),
        origin: origin.clone(),
        source: UsageScanSource::OpenCode,
    });
    roots.push(ScanRoot {
        cli: "grokbuild",
        path: home.join(".grok").join("sessions"),
        origin: origin.clone(),
        source: UsageScanSource::GrokBuild,
    });
    roots.push(ScanRoot {
        cli: "grokbuild",
        path: home.join(".grok").join("archived_sessions"),
        origin: origin.clone(),
        source: UsageScanSource::GrokBuild,
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
                source: UsageScanSource::Jsonl,
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

fn file_identity(metadata: &fs::Metadata) -> (u64, u64) {
    // The resume id is the primary identity. These stable metadata fields detect
    // the common append/truncate/replace cases without platform-specific APIs.
    (metadata.len(), modified_mtime_ms(metadata).max(0) as u64)
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
    use super::{
        collect_codex_home_scan_roots, collect_scan_roots, count_input_chars,
        ready_claude_snapshot, ready_codex_snapshot, ready_snapshot, valid_context_session_id,
        wsl_home_from_cwd, ContextObservation, ContextRequest, ScanOrigin, UsageStatsService,
        DEFAULT_CLAUDE_CONTEXT_TOKENS,
    };
    use crate::models::provider::{Provider, ProviderConfig, ProviderModel, ProviderType};
    use crate::models::{ContextUsageStatus, UsageEntry, WslDistro, WslDistroState};
    use crate::repository::{Database, HistoryRepository, LaunchRecord, UsageStatsRepository};
    use crate::services::{LaunchHistoryService, ProviderService};
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Arc;

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
    fn context_session_id_validation_rejects_path_input() {
        assert!(valid_context_session_id("session-123"));
        assert!(!valid_context_session_id("../session-123"));
        assert!(!valid_context_session_id(""));
    }

    #[test]
    fn claude_context_uses_input_and_cache_tokens_without_output() {
        let snapshot = ready_claude_snapshot(
            "claude-session",
            UsageEntry {
                date: "2026-01-01".to_string(),
                token_input: 10,
                token_output: 900,
                token_cache_read: 30,
                token_cache_creation: 40,
            },
            1_000_000,
            Some("claude-sonnet".to_string()),
            1,
        );

        assert_eq!(snapshot.status, ContextUsageStatus::Ready);
        assert_eq!(snapshot.used_tokens, Some(80));
        assert_eq!(snapshot.used_percentage, Some(0));
        assert_eq!(snapshot.window_source.as_deref(), Some("claude-jsonl"));
    }

    #[test]
    fn codex_context_applies_the_12k_effective_baseline() {
        let snapshot = ready_codex_snapshot(
            "codex-session",
            UsageEntry {
                date: "2026-01-01".to_string(),
                token_input: 100_000,
                token_output: 39_000,
                token_cache_read: 0,
                token_cache_creation: 0,
            },
            Some(139_000),
            Some(353_000),
            Some("gpt-5.6-sol".to_string()),
            1,
        );

        assert_eq!(snapshot.used_tokens, Some(139_000));
        assert_eq!(snapshot.effective_used_tokens, Some(127_000));
        assert_eq!(snapshot.effective_window_tokens, Some(341_000));
        assert_eq!(snapshot.used_percentage, Some(37));
    }

    #[test]
    fn percentage_overflow_returns_null_without_losing_raw_usage() {
        let snapshot = ready_snapshot(
            "overflow-session",
            u64::MAX,
            u64::MAX,
            1_000,
            1_000,
            None,
            "claude-jsonl",
            "claude-jsonl",
            1,
        );

        assert_eq!(snapshot.used_tokens, Some(u64::MAX));
        assert_eq!(snapshot.used_percentage, None);
        assert_eq!(snapshot.remaining_percentage, None);
    }

    fn context_request(cli: &str, model_id: Option<&str>) -> ContextRequest {
        ContextRequest {
            record: LaunchRecord {
                id: 1,
                project_id: "project".to_string(),
                project_name: "Project".to_string(),
                project_path: "/tmp/project".to_string(),
                launched_at: "2026-01-01T00:00:00Z".to_string(),
                pty_session_id: Some("pty".to_string()),
                resume_session_id: Some("resume".to_string()),
                cli_tool: cli.to_string(),
                runtime_kind: "local".to_string(),
                wsl_distro: None,
                last_prompt: None,
                workspace_name: None,
                workspace_path: None,
                launch_cwd: None,
                provider_id: Some("provider".to_string()),
                model_id: model_id.map(str::to_string),
                provider_selection: None,
                launch_profile_id: None,
                workspace_snapshot_id: None,
                resume_source: None,
            },
            pty_session_id: "pty".to_string(),
            cli: cli.to_string(),
            resume_id: "resume".to_string(),
        }
    }

    fn provider_aware_service(default_model_id: Option<&str>) -> UsageStatsService {
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        let history = Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(
            db.clone(),
        ))));
        let usage_repo = Arc::new(UsageStatsRepository::new(db));
        let config_path = tempfile::tempdir().expect("provider temp dir");
        let provider = Provider {
            id: "provider".to_string(),
            name: "Provider".to_string(),
            provider_type: ProviderType::Anthropic,
            api_key: None,
            base_url: None,
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            models: vec![ProviderModel {
                id: "claude-configured".to_string(),
                label: None,
                default_effort: None,
                context_window_tokens: Some(1_000_000),
                context_size: None,
            }],
            default_model_id: default_model_id.map(str::to_string),
            is_default: true,
        };
        let mut default_provider_ids = HashMap::new();
        default_provider_ids.insert("claude".to_string(), "other-provider".to_string());
        let other_provider = Provider {
            id: "other-provider".to_string(),
            name: "Other Provider".to_string(),
            provider_type: ProviderType::Anthropic,
            api_key: None,
            base_url: None,
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            models: vec![ProviderModel {
                id: "MiniMax-M3-highspeed".to_string(),
                label: None,
                default_effort: None,
                context_window_tokens: Some(1_000_000),
                context_size: None,
            }],
            default_model_id: Some("MiniMax-M3-highspeed".to_string()),
            is_default: false,
        };
        let config = ProviderConfig {
            providers: vec![provider, other_provider],
            default_provider_ids,
            default_provider_ids_version: 2,
            default_is_system: false,
        };
        let path = config_path.path().join("providers.json");
        fs::write(
            &path,
            serde_json::to_string(&config).expect("provider json"),
        )
        .expect("write provider config");
        let providers = Arc::new(ProviderService::new(path));
        UsageStatsService::new_with_provider(usage_repo, history, providers)
    }

    #[test]
    fn claude_context_uses_launch_provider_window_when_jsonl_has_none() {
        let service = provider_aware_service(None);
        let request = context_request("claude", Some("claude-configured"));
        let snapshot = service.context_observation_snapshot(
            &request,
            Some(&ContextObservation {
                used_tokens: 80_000,
                window_tokens: None,
                window_diagnostic: None,
                model: Some("claude-configured".to_string()),
            }),
            1,
        );

        assert_eq!(snapshot.window_tokens, Some(1_000_000));
        assert_eq!(snapshot.window_source.as_deref(), Some("provider-model"));
        assert_eq!(snapshot.diagnostic_code, None);
    }

    #[test]
    fn provider_fallback_preserves_an_invalid_jsonl_window_diagnostic() {
        let service = provider_aware_service(None);
        let request = context_request("claude", Some("claude-configured"));
        let snapshot = service.context_observation_snapshot(
            &request,
            Some(&ContextObservation {
                used_tokens: 80_000,
                window_tokens: None,
                window_diagnostic: Some("WINDOW_INVALID".to_string()),
                model: Some("claude-configured".to_string()),
            }),
            1,
        );

        assert_eq!(snapshot.window_tokens, Some(1_000_000));
        assert_eq!(snapshot.window_source.as_deref(), Some("provider-model"));
        assert_eq!(snapshot.diagnostic_code.as_deref(), Some("WINDOW_INVALID"));
    }

    #[test]
    fn context_uses_observed_model_when_launch_provider_metadata_is_stale() {
        let service = provider_aware_service(None);
        let request = context_request("claude", Some("MiniMax-M3-highspeed"));
        let snapshot = service.context_observation_snapshot(
            &request,
            Some(&ContextObservation {
                used_tokens: 56_000,
                window_tokens: None,
                window_diagnostic: None,
                model: Some("MiniMax-M3-highspeed".to_string()),
            }),
            1,
        );

        assert_eq!(snapshot.window_tokens, Some(1_000_000));
        assert_eq!(snapshot.used_percentage, Some(6));
        assert_eq!(snapshot.window_source.as_deref(), Some("provider-model"));
    }

    #[test]
    fn context_without_model_uses_the_launch_provider_default() {
        let service = provider_aware_service(Some("claude-configured"));
        let request = context_request("claude", None);
        let snapshot = service.context_observation_snapshot(
            &request,
            Some(&ContextObservation {
                used_tokens: 80_000,
                window_tokens: None,
                window_diagnostic: None,
                model: None,
            }),
            1,
        );

        assert_eq!(snapshot.window_tokens, Some(1_000_000));
        assert_eq!(snapshot.window_source.as_deref(), Some("provider-model"));
    }

    #[test]
    fn codex_runtime_window_wins_over_provider_metadata() {
        let service = provider_aware_service(None);
        let request = context_request("codex", Some("claude-configured"));
        let snapshot = service.context_observation_snapshot(
            &request,
            Some(&ContextObservation {
                used_tokens: 139_000,
                window_tokens: Some(353_000),
                window_diagnostic: None,
                model: Some("claude-configured".to_string()),
            }),
            1,
        );

        assert_eq!(snapshot.window_tokens, Some(353_000));
        assert_eq!(snapshot.effective_window_tokens, Some(341_000));
        assert_eq!(snapshot.window_source.as_deref(), Some("codex-jsonl"));
    }

    #[test]
    fn claude_context_falls_back_to_1m_when_no_provider_or_observed_model_match() {
        // 配置里没有任何 model 能 hit（包括 observed_model 也不命中），但 launch
        // 注入了 provider_service —— 此时 claude 必须走 1M 兜底而不是 WINDOW_UNKNOWN。
        // 验证 status=Ready、window_tokens=1M、window_source=default-fallback:1m，
        // 且 percentage 按 used/window 算出。
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        let history = Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(
            db.clone(),
        ))));
        let usage_repo = Arc::new(UsageStatsRepository::new(db));
        let config_path = tempfile::tempdir().expect("provider temp dir");
        // provider 存在但没有任何 model 能跟 observed_model 匹配
        let provider = Provider {
            id: "provider".to_string(),
            name: "Provider".to_string(),
            provider_type: ProviderType::Anthropic,
            api_key: None,
            base_url: None,
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            models: vec![ProviderModel {
                id: "other-model".to_string(),
                label: None,
                default_effort: None,
                context_window_tokens: Some(100_000),
                context_size: None,
            }],
            default_model_id: Some("other-model".to_string()),
            is_default: true,
        };
        let config = ProviderConfig {
            providers: vec![provider],
            default_provider_ids: HashMap::new(),
            default_provider_ids_version: 2,
            default_is_system: false,
        };
        let path = config_path.path().join("providers.json");
        fs::write(
            &path,
            serde_json::to_string(&config).expect("provider json"),
        )
        .expect("write provider config");
        let providers = Arc::new(ProviderService::new(path));
        let service = UsageStatsService::new_with_provider(usage_repo, history, providers);

        let request = context_request("claude", Some("totally-unknown-model"));
        let snapshot = service.context_observation_snapshot(
            &request,
            Some(&ContextObservation {
                used_tokens: 250_000,
                window_tokens: None,
                window_diagnostic: None,
                model: Some("totally-unknown-model".to_string()),
            }),
            1,
        );

        assert_eq!(snapshot.status, ContextUsageStatus::Ready);
        assert_eq!(
            snapshot.window_tokens,
            Some(DEFAULT_CLAUDE_CONTEXT_TOKENS),
            "三层 lookup 全 miss 时 claude 必须走 1M 兜底而非 WINDOW_UNKNOWN"
        );
        assert_eq!(snapshot.effective_window_tokens, Some(1_000_000));
        assert_eq!(
            snapshot.window_source.as_deref(),
            Some("default-fallback:1m")
        );
        assert_eq!(snapshot.diagnostic_code, None);
        // 25% 占比
        assert_eq!(snapshot.used_percentage, Some(25));
    }

    #[test]
    fn codex_does_not_get_the_claude_default_fallback() {
        // 同一个 miss 场景换成 codex —— codex 需要 `effective = window - 12_000`，
        // 没有真实 window 不能硬编，必须仍走 WINDOW_UNKNOWN。
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        let history = Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(
            db.clone(),
        ))));
        let usage_repo = Arc::new(UsageStatsRepository::new(db));
        let config_path = tempfile::tempdir().expect("provider temp dir");
        let provider = Provider {
            id: "provider".to_string(),
            name: "Provider".to_string(),
            provider_type: ProviderType::Anthropic,
            api_key: None,
            base_url: None,
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            models: vec![],
            default_model_id: None,
            is_default: true,
        };
        let config = ProviderConfig {
            providers: vec![provider],
            default_provider_ids: HashMap::new(),
            default_provider_ids_version: 2,
            default_is_system: false,
        };
        let path = config_path.path().join("providers.json");
        fs::write(
            &path,
            serde_json::to_string(&config).expect("provider json"),
        )
        .expect("write provider config");
        let providers = Arc::new(ProviderService::new(path));
        let service = UsageStatsService::new_with_provider(usage_repo, history, providers);

        let request = context_request("codex", None);
        let snapshot = service.context_observation_snapshot(
            &request,
            Some(&ContextObservation {
                used_tokens: 50_000,
                window_tokens: None,
                window_diagnostic: None,
                model: Some("totally-unknown-model".to_string()),
            }),
            1,
        );

        assert_eq!(
            snapshot.window_tokens, None,
            "codex 三层 miss 不能套用 claude 的 1M 兜底"
        );
        assert_eq!(snapshot.diagnostic_code.as_deref(), Some("WINDOW_UNKNOWN"));
    }

    #[test]
    fn context_uses_observed_model_suffix_when_no_provider_match() {
        // Claude Code 启动后观察到的 model 字段是 `ANTHROPIC_MODEL` 拼后缀的形式——
        // 例如 `MiniMax-M3-highspeed[1m]`。observed_model 命中后**第一层**就反解出
        // token 数，不走 Provider DB lookup——与 ccpanel `parse_context_window_from_model`
        // 对齐。
        let service = provider_aware_service(None);
        let request = context_request("claude", None);
        let snapshot = service.context_observation_snapshot(
            &request,
            Some(&ContextObservation {
                used_tokens: 200_000,
                window_tokens: None,
                window_diagnostic: None,
                model: Some("MiniMax-M3-highspeed[1m]".to_string()),
            }),
            1,
        );

        assert_eq!(snapshot.window_tokens, Some(1_000_000));
        assert_eq!(snapshot.effective_window_tokens, Some(1_000_000));
        assert_eq!(snapshot.used_percentage, Some(20));
        assert_eq!(
            snapshot.window_source.as_deref(),
            Some("provider-model"),
            "observed suffix 反解命中归类为 provider-model（与 ccpanel 一致）"
        );
        assert_eq!(snapshot.diagnostic_code, None);
    }

    #[test]
    fn context_without_window_is_ready_with_raw_usage_and_unknown_diagnostic() {
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        let history = Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(
            db.clone(),
        ))));
        let service = UsageStatsService::new(Arc::new(UsageStatsRepository::new(db)), history);
        let request = context_request("claude", None);
        let snapshot = service.context_observation_snapshot(
            &request,
            Some(&ContextObservation {
                used_tokens: 81_234,
                window_tokens: None,
                window_diagnostic: None,
                model: None,
            }),
            1,
        );

        assert_eq!(snapshot.status, ContextUsageStatus::Ready);
        assert_eq!(snapshot.used_tokens, Some(81_234));
        assert_eq!(snapshot.effective_used_tokens, Some(81_234));
        assert_eq!(snapshot.window_tokens, None);
        assert_eq!(snapshot.used_percentage, None);
        assert_eq!(snapshot.window_source.as_deref(), Some("unknown"));
        assert_eq!(snapshot.diagnostic_code.as_deref(), Some("WINDOW_UNKNOWN"));
    }

    #[test]
    fn wsl_home_resolution_preserves_the_user_segment() {
        let path = wsl_home_from_cwd(
            "Ubuntu-24.04",
            "//wsl.localhost/Ubuntu-24.04/home/Alice/project",
        )
        .expect("wsl home");
        assert!(path.to_string_lossy().contains("home\\Alice"));
    }

    #[test]
    fn collect_scan_roots_windows_only() {
        let roots = collect_scan_roots(&[], true);

        assert!(roots.len() >= 2);
        assert!(roots.iter().any(|root| root.cli == "claude"));
        assert!(roots.iter().any(|root| root.cli == "codex"));
        assert!(roots.iter().all(|root| root.origin == ScanOrigin::Native));
    }

    #[test]
    fn collect_scan_roots_with_wsl() {
        let roots = collect_scan_roots(
            &[
                wsl_distro("Ubuntu", WslDistroState::Running, Some("alice")),
                wsl_distro("NoUser", WslDistroState::Running, None),
            ],
            true,
        );

        assert!(roots.len() >= 4);
        let wsl_roots = roots
            .iter()
            .filter(|root| matches!(root.origin, ScanOrigin::Wsl { .. }))
            .collect::<Vec<_>>();
        assert_eq!(wsl_roots.len(), 6);
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
        let roots = collect_scan_roots(
            &[wsl_distro("Ubuntu", WslDistroState::Stopped, Some("alice"))],
            true,
        );

        assert!(roots.len() >= 2);
        assert!(roots.iter().all(|root| root.origin == ScanOrigin::Native));
    }

    #[test]
    fn collect_scan_roots_skips_wsl_when_vm_not_running() {
        // 缓存仍标 Running（最长 50 分钟 stale），但 VM 已被关掉：
        // 必须忽略 WSL 根，否则 \\wsl$ 访问会把 distro 重新唤醒。
        let roots = collect_scan_roots(
            &[wsl_distro("Ubuntu", WslDistroState::Running, Some("alice"))],
            false,
        );

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
