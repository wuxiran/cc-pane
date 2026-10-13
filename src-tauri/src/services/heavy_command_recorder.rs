//! 重负载命令台账的 hook 记录器（docs/107 P2b）。
//!
//! 接在 orchestrator `handle_hook_event` 的 `on_event` **之前**，只认 `tool_name == "Bash"`：
//! - ToolBefore → 插一行（会话上下文查 `terminal_sessions`），记下 (session, tool_use_id) → 行 id；
//! - ToolAfter → 补 `ended_at / duration_ms / exit_code`。
//! - 采样器封账的 episode 也从这里进库（`merge_episode`），与 hook 行合并。
//!
//! **绝不阻塞 hook 热路径**：所有 SQLite 写都在一条专用线程里按序执行（有界通道 +
//! `try_send`，满了就丢并计数）。顺序性保证 ToolBefore 一定先于同一 tool_use_id 的
//! ToolAfter 落库——spawn_blocking 做不到这一点。
//!
//! 隐私红线：进通道前就已 `normalize` / `redact`，原始命令行不出本函数。

use cc_cli_adapters::CcPaneEvent;
use cc_panes_core::models::{
    HeavyCommandSource, HeavyEpisode, HeavySessionContext, NewHeavyCommand,
};
use cc_panes_core::repository::HeavyCommandsRepository;
use cc_panes_core::services::heavy_command_normalize::{normalize, redact};
use cc_panes_core::services::SettingsService;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, warn};

/// 通道容量：hook 事件每秒最多几条，1024 足够吸收一次 SQLite 卡顿。
const QUEUE_CAPACITY: usize = 1024;
/// 后台线程空闲多久跑一次 `prune`。
const PRUNE_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// 同一会话悬着的起始行上限：CLI 被杀、ToolAfter 永远不来时不让 map 无界增长。
const MAX_PENDING_PER_SESSION: usize = 64;
/// 悬着的起始行最多留多久：ToolAfter 24 h 还不来就是永远不来了（会话早没了）。
pub(crate) const PENDING_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
/// 悬挂表的键数上限（会话 × tool_use_id）。超出按最早起始行逐出。
pub(crate) const MAX_PENDING_KEYS: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Message {
    Before {
        session_id: String,
        tool_use_id: Option<String>,
        cmd_normalized: String,
        cmd_redacted: String,
        at: i64,
    },
    After {
        session_id: String,
        tool_use_id: Option<String>,
        exit_code: Option<i32>,
        at: i64,
    },
    Episode(HeavyEpisode),
    Prune,
}

/// 从 hook payload 抽出的 Bash 调用（纯函数，便于单测）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BashHookSample {
    pub tool_use_id: Option<String>,
    /// 仅 ToolBefore 有；ToolAfter 为空。
    pub command: Option<String>,
    pub exit_code: Option<i32>,
    pub is_after: bool,
}

/// 只认 Bash；其他工具 / 其他事件返回 None。
pub(crate) fn parse_bash_hook(
    event: &CcPaneEvent,
    payload: &serde_json::Value,
) -> Option<BashHookSample> {
    let is_after = match event {
        CcPaneEvent::ToolBefore(_) => false,
        CcPaneEvent::ToolAfter(_) => true,
        _ => return None,
    };
    let tool_name = payload.get("tool_name").and_then(|v| v.as_str())?;
    if !tool_name.eq_ignore_ascii_case("bash") {
        return None;
    }
    let tool_use_id = payload
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let command = if is_after {
        None
    } else {
        payload
            .get("tool_input")
            .or_else(|| payload.get("input"))
            .and_then(|input| input.get("command"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    if !is_after && command.as_deref().is_none_or(|c| c.trim().is_empty()) {
        return None;
    }
    let exit_code = is_after
        .then(|| payload.get("tool_response"))
        .flatten()
        .and_then(extract_exit_code);
    Some(BashHookSample {
        tool_use_id,
        command,
        exit_code,
        is_after,
    })
}

fn extract_exit_code(response: &serde_json::Value) -> Option<i32> {
    if response
        .get("interrupted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    for key in ["exit_code", "exitCode", "returncode", "code"] {
        if let Some(code) = response.get(key).and_then(|v| v.as_i64()) {
            return i32::try_from(code).ok();
        }
    }
    None
}

/// 悬着的起始行：行 id + 起始时刻（逐出用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingStart {
    id: i64,
    at: i64,
}

/// 后台线程的工作体。与线程分离是为了让测试不起线程直接驱动。
pub(crate) struct Worker {
    repo: Arc<HeavyCommandsRepository>,
    /// (session_id, tool_use_id) → 行。tool_use_id 缺失时键为 (session_id, "")，
    /// 同一会话顺序配对（Codex 等不带 id 的 CLI）。
    /// 每个 `Prune` 按 [`PENDING_MAX_AGE_MS`] / [`MAX_PENDING_KEYS`] 逐出，否则会话
    /// 被杀时没配上的起始行会在这里留到 app 退出。
    pending: HashMap<(String, String), Vec<PendingStart>>,
}

impl Worker {
    pub(crate) fn new(repo: Arc<HeavyCommandsRepository>) -> Self {
        Self {
            repo,
            pending: HashMap::new(),
        }
    }

    fn context_for(&self, session_id: &str) -> HeavySessionContext {
        match self.repo.session_context(session_id) {
            Ok(Some(context)) => context,
            Ok(None) => HeavySessionContext::default(),
            Err(error) => {
                debug!(%session_id, %error, "[heavy-ledger] session context lookup failed");
                HeavySessionContext::default()
            }
        }
    }

    pub(crate) fn handle(&mut self, message: Message) {
        match message {
            Message::Before {
                session_id,
                tool_use_id,
                cmd_normalized,
                cmd_redacted,
                at,
            } => {
                let row = NewHeavyCommand {
                    context: self.context_for(&session_id),
                    session_id: session_id.clone(),
                    cmd_normalized,
                    cmd_redacted,
                    source: HeavyCommandSource::Hook,
                    started_at: at,
                };
                match self.repo.insert(&row) {
                    Ok(id) => {
                        let key = (session_id, tool_use_id.unwrap_or_default());
                        let slot = self.pending.entry(key).or_default();
                        slot.push(PendingStart { id, at });
                        if slot.len() > MAX_PENDING_PER_SESSION {
                            slot.remove(0);
                        }
                    }
                    Err(error) => warn!(%error, "[heavy-ledger] insert failed"),
                }
            }
            Message::After {
                session_id,
                tool_use_id,
                exit_code,
                at,
            } => {
                let key = (session_id, tool_use_id.unwrap_or_default());
                let Some(slot) = self.pending.get_mut(&key) else {
                    return;
                };
                // 同键多行（无 tool_use_id 的 CLI）按 FIFO 配对。
                let PendingStart { id, .. } = slot.remove(0);
                if slot.is_empty() {
                    self.pending.remove(&key);
                }
                if let Err(error) = self.repo.finish(id, at, exit_code) {
                    warn!(%error, "[heavy-ledger] finish failed");
                }
            }
            Message::Episode(mut episode) => {
                episode.context = self.context_for(&episode.session_id);
                if let Err(error) = self.repo.merge_episode(&episode) {
                    warn!(%error, "[heavy-ledger] merge_episode failed");
                }
            }
            Message::Prune => {
                let now = now_millis();
                let evicted = self.evict_stale_pending(now);
                if evicted > 0 {
                    debug!(evicted, "[heavy-ledger] dropped unmatched pending starts");
                }
                match self.repo.prune(now) {
                    Ok(removed) if removed > 0 => {
                        debug!(removed, "[heavy-ledger] pruned ledger rows")
                    }
                    Ok(_) => {}
                    Err(error) => warn!(%error, "[heavy-ledger] prune failed"),
                }
            }
        }
    }

    /// 逐出超过 [`PENDING_MAX_AGE_MS`] 的起始行；键数仍超 [`MAX_PENDING_KEYS`] 时按最早
    /// 起始行继续逐出整键。返回逐出的行数。
    pub(crate) fn evict_stale_pending(&mut self, now: i64) -> usize {
        let cutoff = now.saturating_sub(PENDING_MAX_AGE_MS);
        let mut evicted = 0usize;
        self.pending.retain(|_, slot| {
            let before = slot.len();
            slot.retain(|start| start.at >= cutoff);
            evicted += before - slot.len();
            !slot.is_empty()
        });
        if self.pending.len() > MAX_PENDING_KEYS {
            let mut by_age: Vec<((String, String), i64)> = self
                .pending
                .iter()
                .map(|(key, slot)| {
                    (
                        key.clone(),
                        slot.iter().map(|start| start.at).min().unwrap_or(i64::MAX),
                    )
                })
                .collect();
            by_age.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
            let excess = self.pending.len() - MAX_PENDING_KEYS;
            for (key, _) in by_age.into_iter().take(excess) {
                if let Some(slot) = self.pending.remove(&key) {
                    evicted += slot.len();
                }
            }
        }
        evicted
    }

    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        self.pending.values().map(Vec::len).sum()
    }
}

/// 进程内单例；`Arc` 由 Tauri `manage`，orchestrator 经 `app_handle.try_state` 取。
pub struct HeavyCommandRecorder {
    sender: mpsc::SyncSender<Message>,
    settings: Arc<SettingsService>,
    dropped: AtomicU64,
}

impl HeavyCommandRecorder {
    pub fn start(repo: Arc<HeavyCommandsRepository>, settings: Arc<SettingsService>) -> Arc<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Message>(QUEUE_CAPACITY);
        let worker_repo = repo;
        std::thread::Builder::new()
            .name("heavy-ledger".into())
            .spawn(move || {
                let mut worker = Worker::new(worker_repo);
                worker.handle(Message::Prune);
                loop {
                    match receiver.recv_timeout(PRUNE_INTERVAL) {
                        Ok(message) => worker.handle(message),
                        Err(mpsc::RecvTimeoutError::Timeout) => worker.handle(Message::Prune),
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .map_err(|error| warn!(%error, "[heavy-ledger] worker thread spawn failed"))
            .ok();
        Arc::new(Self {
            sender,
            settings,
            dropped: AtomicU64::new(0),
        })
    }

    fn enabled(&self) -> bool {
        self.settings
            .get_settings()
            .performance
            .heavy_ledger_enabled
    }

    /// hook 热路径入口：解析 + 归一化 + 入队，微秒级，不等 SQLite。
    pub fn record_hook_event(
        &self,
        session_id: &str,
        event: &CcPaneEvent,
        payload: &serde_json::Value,
    ) {
        let Some(sample) = parse_bash_hook(event, payload) else {
            return;
        };
        if !self.enabled() {
            return;
        }
        let at = now_millis();
        let message = if sample.is_after {
            Message::After {
                session_id: session_id.to_string(),
                tool_use_id: sample.tool_use_id,
                exit_code: sample.exit_code,
                at,
            }
        } else {
            let command = sample.command.unwrap_or_default();
            Message::Before {
                session_id: session_id.to_string(),
                tool_use_id: sample.tool_use_id,
                cmd_normalized: normalize(&command),
                cmd_redacted: redact(&command),
                at,
            }
        };
        self.send(message);
    }

    /// 采样器封账。`episode.context` 由后台线程回填，调用方留默认即可。
    pub fn record_episode(&self, episode: HeavyEpisode) {
        if !self.enabled() {
            return;
        }
        self.send(Message::Episode(episode));
    }

    fn send(&self, message: Message) {
        if let Err(error) = self.sender.try_send(message) {
            let dropped = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
            if dropped.is_power_of_two() {
                warn!(dropped, %error, "[heavy-ledger] queue full; dropping ledger message");
            }
        }
    }

    pub fn dropped_messages(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_cli_adapters::ToolMatcher;
    use cc_panes_core::models::HeavyCommandQuery;
    use cc_panes_core::repository::Database;
    use serde_json::json;

    fn before() -> CcPaneEvent {
        CcPaneEvent::ToolBefore(ToolMatcher::default())
    }

    fn after() -> CcPaneEvent {
        CcPaneEvent::ToolAfter(ToolMatcher::default())
    }

    #[test]
    fn parse_bash_hook_only_accepts_bash_tool_events() {
        let payload = json!({
            "tool_name": "Bash",
            "tool_use_id": "toolu_1",
            "tool_input": { "command": "cargo build --release" }
        });
        let sample = parse_bash_hook(&before(), &payload).expect("bash before");
        assert_eq!(sample.tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(sample.command.as_deref(), Some("cargo build --release"));
        assert!(!sample.is_after);

        let other_tool = json!({ "tool_name": "Read", "tool_input": { "command": "x" } });
        assert!(parse_bash_hook(&before(), &other_tool).is_none());

        let other_event = parse_bash_hook(&CcPaneEvent::TurnEnd, &payload);
        assert!(other_event.is_none());

        let empty = json!({ "tool_name": "Bash", "tool_input": { "command": "  " } });
        assert!(parse_bash_hook(&before(), &empty).is_none());
    }

    #[test]
    fn parse_bash_hook_after_extracts_exit_code_and_ignores_interrupted() {
        let ok = json!({
            "tool_name": "Bash",
            "tool_use_id": "toolu_1",
            "tool_response": { "stdout": "", "exit_code": 3 }
        });
        let sample = parse_bash_hook(&after(), &ok).expect("bash after");
        assert!(sample.is_after);
        assert_eq!(sample.exit_code, Some(3));
        assert!(sample.command.is_none());

        let interrupted = json!({
            "tool_name": "Bash",
            "tool_response": { "interrupted": true, "exit_code": 130 }
        });
        assert_eq!(
            parse_bash_hook(&after(), &interrupted).unwrap().exit_code,
            None
        );

        let no_code = json!({ "tool_name": "Bash", "tool_response": { "stdout": "ok" } });
        assert_eq!(parse_bash_hook(&after(), &no_code).unwrap().exit_code, None);
    }

    fn worker() -> (Worker, Arc<HeavyCommandsRepository>, Arc<Database>) {
        let db = Arc::new(Database::new_fallback().expect("db"));
        let repo = Arc::new(HeavyCommandsRepository::new(db.clone()));
        (Worker::new(repo.clone()), repo, db)
    }

    #[test]
    fn worker_pairs_before_and_after_by_tool_use_id() {
        let (mut worker, repo, _db) = worker();
        worker.handle(Message::Before {
            session_id: "s1".into(),
            tool_use_id: Some("a".into()),
            cmd_normalized: "cargo build".into(),
            cmd_redacted: "cargo build --release".into(),
            at: 1_000,
        });
        worker.handle(Message::Before {
            session_id: "s1".into(),
            tool_use_id: Some("b".into()),
            cmd_normalized: "rg".into(),
            cmd_redacted: "rg foo".into(),
            at: 2_000,
        });
        assert_eq!(worker.pending_len(), 2);
        // 乱序 After：b 先结束
        worker.handle(Message::After {
            session_id: "s1".into(),
            tool_use_id: Some("b".into()),
            exit_code: Some(1),
            at: 2_500,
        });
        worker.handle(Message::After {
            session_id: "s1".into(),
            tool_use_id: Some("a".into()),
            exit_code: Some(0),
            at: 31_000,
        });
        assert_eq!(worker.pending_len(), 0);

        let rows = repo.list(&HeavyCommandQuery::default()).unwrap();
        let build = rows
            .iter()
            .find(|r| r.cmd_normalized == "cargo build")
            .unwrap();
        assert_eq!(build.duration_ms, Some(30_000));
        assert_eq!(build.exit_code, Some(0));
        let rg = rows.iter().find(|r| r.cmd_normalized == "rg").unwrap();
        assert_eq!(rg.duration_ms, Some(500));
        assert_eq!(rg.exit_code, Some(1));
    }

    #[test]
    fn worker_without_tool_use_id_pairs_fifo_per_session_and_ignores_unmatched_after() {
        let (mut worker, repo, _db) = worker();
        for at in [1_000, 2_000] {
            worker.handle(Message::Before {
                session_id: "codex".into(),
                tool_use_id: None,
                cmd_normalized: "cargo test".into(),
                cmd_redacted: "cargo test".into(),
                at,
            });
        }
        worker.handle(Message::After {
            session_id: "codex".into(),
            tool_use_id: None,
            exit_code: Some(0),
            at: 5_000,
        });
        // 无匹配起始行的 After 必须被安静忽略（app 重启后的半截调用）
        worker.handle(Message::After {
            session_id: "unknown".into(),
            tool_use_id: Some("zzz".into()),
            exit_code: Some(0),
            at: 5_000,
        });
        let rows = repo.list(&HeavyCommandQuery::default()).unwrap();
        assert_eq!(rows.len(), 2);
        let first = rows.iter().find(|r| r.started_at == 1_000).unwrap();
        assert_eq!(
            first.duration_ms,
            Some(4_000),
            "FIFO: oldest start closes first"
        );
        let second = rows.iter().find(|r| r.started_at == 2_000).unwrap();
        assert_eq!(second.duration_ms, None);
        assert_eq!(worker.pending_len(), 1);
    }

    /// 审查 #9：ToolAfter 永远不来的起始行要在 Prune 时逐出（24 h），键数封顶。
    #[test]
    fn prune_evicts_stale_pending_starts_and_caps_key_count() {
        let (mut worker, _repo, _db) = worker();
        let before = |session: &str, id: &str, at: i64| Message::Before {
            session_id: session.into(),
            tool_use_id: Some(id.into()),
            cmd_normalized: "cargo build".into(),
            cmd_redacted: "cargo build".into(),
            at,
        };
        let now = 10 * PENDING_MAX_AGE_MS;
        worker.handle(before("s1", "old", now - PENDING_MAX_AGE_MS - 1));
        worker.handle(before("s1", "fresh", now - 1_000));
        worker.handle(before("s2", "fresh-2", now));
        assert_eq!(worker.pending_len(), 3);

        assert_eq!(worker.evict_stale_pending(now), 1);
        assert_eq!(worker.pending_len(), 2, "only the 24 h old start goes");
        // 逐出后 After 匹配不上就被安静忽略；新鲜的仍可配对
        worker.handle(Message::After {
            session_id: "s1".into(),
            tool_use_id: Some("old".into()),
            exit_code: Some(0),
            at: now,
        });
        worker.handle(Message::After {
            session_id: "s1".into(),
            tool_use_id: Some("fresh".into()),
            exit_code: Some(0),
            at: now,
        });
        assert_eq!(worker.pending_len(), 1);

        // 键数封顶：超过 MAX_PENDING_KEYS 时最早的键先走
        for i in 0..(MAX_PENDING_KEYS + 5) {
            worker.handle(before("flood", &format!("t{i}"), now + i as i64));
        }
        assert!(worker.pending_len() > MAX_PENDING_KEYS);
        let evicted = worker.evict_stale_pending(now + 10);
        assert!(evicted >= 6, "evicted={evicted}");
        assert_eq!(worker.pending_len(), MAX_PENDING_KEYS);
        // 最老的（s2/fresh-2 at=now 与 flood/t0..）先走，最新的 flood/t1028 还在
        worker.handle(Message::After {
            session_id: "flood".into(),
            tool_use_id: Some(format!("t{}", MAX_PENDING_KEYS + 4)),
            exit_code: Some(0),
            at: now + 100,
        });
        assert_eq!(worker.pending_len(), MAX_PENDING_KEYS - 1);

        // 走 Prune 消息也会逐出（真实时钟：1970 年的起始行一定过期）
        worker.handle(before("ancient", "x", 1_000));
        worker.handle(Message::Prune);
        assert!(worker.pending_len() < MAX_PENDING_KEYS);
    }

    #[test]
    fn worker_fills_episode_context_from_terminal_sessions() {
        let (mut worker, repo, db) = worker();
        db.connection()
            .unwrap()
            .execute_batch(
                "INSERT INTO terminal_sessions
                    (session_id, tab_id, pane_id, project_path, workspace_name, cli_tool,
                     runtime_kind, created_at, saved_at)
                 VALUES ('s1', 't', 'p', 'D:/repo', 'ws', 'claude', 'local', 'now', 'now');",
            )
            .unwrap();
        worker.handle(Message::Episode(HeavyEpisode {
            session_id: "s1".into(),
            context: HeavySessionContext::default(),
            cmd_normalized: "rustc".into(),
            cmd_redacted: "rustc".into(),
            started_at: 1,
            ended_at: 10_000,
            peak_cpu_pct: 300.0,
            peak_mem_bytes: 1,
            cpu_seconds: 9.0,
        }));
        let rows = repo.list(&HeavyCommandQuery::default()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].project_path, "D:/repo");
        assert_eq!(rows[0].workspace.as_deref(), Some("ws"));
        assert_eq!(rows[0].source, HeavyCommandSource::Sampler);
    }
}
