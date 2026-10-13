//! 重负载命令台账（docs/107 P2b）。
//!
//! 隐私红线：只落 `cmd_normalized` / `cmd_redacted`，原始命令行绝不进库；
//! 数据只在本机 data.db，本模块零网络调用。
//!
//! 调用方（hook 记录器 / 采样器）按 fire-and-forget 使用：失败只记日志，
//! 绝不反向阻塞 hook 事件或采样循环。

use crate::models::{
    HeavyCommandAggregate, HeavyCommandQuery, HeavyCommandRecord, HeavyCommandSource, HeavyEpisode,
    HeavySessionContext, NewHeavyCommand,
};
use crate::repository::Database;
use rusqlite::{params, OptionalExtension, Row};
use std::sync::Arc;
use tracing::error;

/// 列表默认上限。
pub const DEFAULT_LIST_LIMIT: u32 = 200;
/// 已封账行保留 30 天。
pub const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// hook 起始行 24 h 没等到 ToolAfter 视为孤儿（CLI 被杀 / app 重启），收掉。
pub const OPEN_ROW_TTL_MS: i64 = 24 * 60 * 60 * 1000;

pub struct HeavyCommandsRepository {
    db: Arc<Database>,
}

impl HeavyCommandsRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 查会话上下文（`terminal_sessions` 由 session_restore 周期落盘，跨实例共享）。
    pub fn session_context(&self, session_id: &str) -> Result<Option<HeavySessionContext>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT project_path, workspace_name, cli_tool, runtime_kind
             FROM terminal_sessions WHERE session_id = ?1",
            params![session_id],
            |row| {
                Ok(HeavySessionContext {
                    project_path: row.get(0)?,
                    workspace: row.get(1)?,
                    cli_tool: row.get(2)?,
                    runtime_kind: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// 插入一行（hook ToolBefore 起始行，`ended_at` 留空）。返回行 id。
    pub fn insert(&self, row: &NewHeavyCommand) -> Result<i64, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO heavy_commands
                (session_id, project_path, workspace, cli_tool, runtime_kind,
                 cmd_normalized, cmd_redacted, source, started_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                row.session_id,
                row.context.project_path,
                row.context.workspace,
                row.context.cli_tool,
                row.context.runtime_kind,
                row.cmd_normalized,
                row.cmd_redacted,
                row.source.as_str(),
                row.started_at,
                now_millis(),
            ],
        )
        .map_err(|e| {
            error!(table = "heavy_commands", err = %e, "SQL insert failed");
            e.to_string()
        })?;
        Ok(conn.last_insert_rowid())
    }

    /// hook ToolAfter：补时长 / 退出码。行已被 prune 掉时返回 `Ok(false)`。
    pub fn finish(&self, id: i64, ended_at: i64, exit_code: Option<i32>) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE heavy_commands
                 SET ended_at = ?2,
                     duration_ms = MAX(0, ?2 - started_at),
                     exit_code = COALESCE(?3, exit_code)
                 WHERE id = ?1",
                params![id, ended_at, exit_code],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    /// W8 门禁归还时回填：同会话、同归一化命令的**最近一行**打上 `target` /
    /// `offloaded_reason`。没有匹配行返回 `Ok(false)`（hook 记录器可能关着），纯尽力而为。
    pub fn mark_target(
        &self,
        session_id: &str,
        cmd_normalized: &str,
        target: &str,
        offloaded_reason: Option<&str>,
    ) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE heavy_commands
                 SET target = ?3, offloaded_reason = ?4
                 WHERE id = (
                     SELECT id FROM heavy_commands
                     WHERE session_id = ?1 AND cmd_normalized = ?2
                     ORDER BY started_at DESC
                     LIMIT 1
                 )",
                params![session_id, cmd_normalized, target, offloaded_reason],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    /// 采样器封账：与同会话、时间重叠的 hook 行合并（source → both），否则新插一行
    /// `source = sampler`。返回被写的行 id。
    ///
    /// 重叠判定：hook 行 `[started_at, ended_at ?? now]` 与 episode 区间相交。
    /// 合并时只**取大**峰值 / 累加 cpu_seconds，不覆盖 hook 行的命令（hook 的命令是
    /// 用户敲的那条，比"最重子进程"更可读）。
    pub fn merge_episode(&self, episode: &HeavyEpisode) -> Result<i64, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let overlapping: Option<i64> = conn
            .query_row(
                "SELECT id FROM heavy_commands
                 WHERE session_id = ?1
                   AND source IN ('hook', 'both')
                   AND started_at <= ?3
                   AND COALESCE(ended_at, ?4) >= ?2
                 ORDER BY started_at DESC LIMIT 1",
                params![
                    episode.session_id,
                    episode.started_at,
                    episode.ended_at,
                    now_millis()
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some(id) = overlapping {
            conn.execute(
                "UPDATE heavy_commands
                 SET source = 'both',
                     peak_cpu_pct = MAX(COALESCE(peak_cpu_pct, 0), ?2),
                     peak_mem_bytes = MAX(COALESCE(peak_mem_bytes, 0), ?3),
                     cpu_seconds = COALESCE(cpu_seconds, 0) + ?4
                 WHERE id = ?1",
                params![
                    id,
                    f64::from(episode.peak_cpu_pct),
                    episode.peak_mem_bytes as i64,
                    episode.cpu_seconds
                ],
            )
            .map_err(|e| e.to_string())?;
            return Ok(id);
        }

        let cmd_normalized = if episode.cmd_normalized.is_empty() {
            "(unknown)"
        } else {
            episode.cmd_normalized.as_str()
        };
        conn.execute(
            "INSERT INTO heavy_commands
                (session_id, project_path, workspace, cli_tool, runtime_kind,
                 cmd_normalized, cmd_redacted, source, started_at, ended_at, duration_ms,
                 peak_cpu_pct, peak_mem_bytes, cpu_seconds, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'sampler', ?8, ?9, MAX(0, ?9 - ?8),
                     ?10, ?11, ?12, ?13)",
            params![
                episode.session_id,
                episode.context.project_path,
                episode.context.workspace,
                episode.context.cli_tool,
                episode.context.runtime_kind,
                cmd_normalized,
                episode.cmd_redacted,
                episode.started_at,
                episode.ended_at,
                f64::from(episode.peak_cpu_pct),
                episode.peak_mem_bytes as i64,
                episode.cpu_seconds,
                now_millis(),
            ],
        )
        .map_err(|e| {
            error!(table = "heavy_commands", err = %e, "SQL merge_episode insert failed");
            e.to_string()
        })?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list(&self, query: &HeavyCommandQuery) -> Result<Vec<HeavyCommandRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let limit = match query.limit {
            Some(0) | None => DEFAULT_LIST_LIMIT,
            Some(limit) => limit,
        };
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, project_path, workspace, cli_tool, runtime_kind,
                        cmd_normalized, cmd_redacted, source, started_at, ended_at, duration_ms,
                        exit_code, peak_cpu_pct, peak_mem_bytes, cpu_seconds, target,
                        offloaded_reason, created_at
                 FROM heavy_commands
                 WHERE (?1 IS NULL OR project_path = ?1)
                   AND (?2 IS NULL OR started_at >= ?2)
                 ORDER BY started_at DESC
                 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![query.project_path, query.since, i64::from(limit)],
                map_record,
            )
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// 按归一化命令聚合。p50/p95 在内存里算（行数受 since 窗口限制，SQLite 没有分位函数）。
    pub fn aggregate(
        &self,
        since: Option<i64>,
        project_path: Option<&str>,
    ) -> Result<Vec<HeavyCommandAggregate>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT cmd_normalized, duration_ms, cpu_seconds, peak_mem_bytes, started_at
                 FROM heavy_commands
                 WHERE (?1 IS NULL OR project_path = ?1)
                   AND (?2 IS NULL OR started_at >= ?2)
                 ORDER BY cmd_normalized, started_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project_path, since], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut aggregates: Vec<HeavyCommandAggregate> = Vec::new();
        let mut durations: Vec<Vec<i64>> = Vec::new();
        for row in rows {
            let (cmd, duration, cpu_seconds, peak_mem, started_at) =
                row.map_err(|e| e.to_string())?;
            let index = match aggregates.iter().position(|a| a.cmd_normalized == cmd) {
                Some(index) => index,
                None => {
                    aggregates.push(HeavyCommandAggregate {
                        cmd_normalized: cmd,
                        runs: 0,
                        total_cpu_seconds: 0.0,
                        p50_duration_ms: None,
                        p95_duration_ms: None,
                        peak_mem_bytes: None,
                        last_started_at: started_at,
                    });
                    durations.push(Vec::new());
                    aggregates.len() - 1
                }
            };
            let entry = &mut aggregates[index];
            entry.runs += 1;
            entry.total_cpu_seconds += cpu_seconds.unwrap_or(0.0);
            entry.last_started_at = entry.last_started_at.max(started_at);
            if let Some(peak) = peak_mem.filter(|peak| *peak > 0) {
                let peak = peak as u64;
                entry.peak_mem_bytes = Some(entry.peak_mem_bytes.map_or(peak, |p| p.max(peak)));
            }
            if let Some(duration) = duration {
                durations[index].push(duration);
            }
        }
        for (entry, samples) in aggregates.iter_mut().zip(durations.iter_mut()) {
            samples.sort_unstable();
            entry.p50_duration_ms = percentile(samples, 50);
            entry.p95_duration_ms = percentile(samples, 95);
        }
        aggregates.sort_by(|left, right| {
            right
                .total_cpu_seconds
                .partial_cmp(&left.total_cpu_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| right.runs.cmp(&left.runs))
                .then_with(|| left.cmd_normalized.cmp(&right.cmd_normalized))
        });
        Ok(aggregates)
    }

    pub fn clear_all(&self) -> Result<usize, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM heavy_commands", [])
            .map_err(|e| e.to_string())
    }

    /// 收旧：已封账行超 30 天、未封账行超 24 h。返回删除行数。
    pub fn prune(&self, now: i64) -> Result<usize, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM heavy_commands
             WHERE (ended_at IS NOT NULL AND started_at < ?1)
                OR (ended_at IS NULL AND started_at < ?2)",
            params![now - RETENTION_MS, now - OPEN_ROW_TTL_MS],
        )
        .map_err(|e| e.to_string())
    }
}

fn percentile(sorted: &[i64], pct: usize) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (sorted.len() - 1) * pct / 100;
    sorted.get(rank).copied()
}

fn map_record(row: &Row<'_>) -> rusqlite::Result<HeavyCommandRecord> {
    Ok(HeavyCommandRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        project_path: row.get(2)?,
        workspace: row.get(3)?,
        cli_tool: row.get(4)?,
        runtime_kind: row.get(5)?,
        cmd_normalized: row.get(6)?,
        cmd_redacted: row.get(7)?,
        source: HeavyCommandSource::parse(&row.get::<_, String>(8)?),
        started_at: row.get(9)?,
        ended_at: row.get(10)?,
        duration_ms: row.get(11)?,
        exit_code: row.get(12)?,
        peak_cpu_pct: row.get::<_, Option<f64>>(13)?.map(|v| v as f32),
        peak_mem_bytes: row.get::<_, Option<i64>>(14)?.map(|v| v.max(0) as u64),
        cpu_seconds: row.get(15)?,
        target: row.get(16)?,
        offloaded_reason: row.get(17)?,
        created_at: row.get(18)?,
    })
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

    fn setup() -> HeavyCommandsRepository {
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        HeavyCommandsRepository::new(db)
    }

    fn context() -> HeavySessionContext {
        HeavySessionContext {
            project_path: "D:/repo".into(),
            workspace: Some("ws".into()),
            cli_tool: "claude".into(),
            runtime_kind: "local".into(),
        }
    }

    fn hook_row(session: &str, cmd: &str, started_at: i64) -> NewHeavyCommand {
        NewHeavyCommand {
            session_id: session.into(),
            context: context(),
            cmd_normalized: cmd.into(),
            cmd_redacted: cmd.into(),
            source: HeavyCommandSource::Hook,
            started_at,
        }
    }

    fn episode(session: &str, started_at: i64, ended_at: i64) -> HeavyEpisode {
        HeavyEpisode {
            session_id: session.into(),
            context: context(),
            cmd_normalized: "rustc".into(),
            cmd_redacted: "rustc --crate-name x".into(),
            started_at,
            ended_at,
            peak_cpu_pct: 480.0,
            peak_mem_bytes: 3 * 1024 * 1024 * 1024,
            cpu_seconds: 120.5,
        }
    }

    #[test]
    fn insert_then_finish_sets_duration_and_exit_code() {
        let repo = setup();
        let id = repo.insert(&hook_row("s1", "cargo build", 1_000)).unwrap();
        assert!(repo.finish(id, 31_000, Some(0)).unwrap());

        let rows = repo.list(&HeavyCommandQuery::default()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].duration_ms, Some(30_000));
        assert_eq!(rows[0].exit_code, Some(0));
        assert_eq!(rows[0].source, HeavyCommandSource::Hook);
        assert_eq!(rows[0].project_path, "D:/repo");
        assert_eq!(rows[0].target, "local");
    }

    #[test]
    fn mark_target_updates_latest_matching_row_only() {
        let repo = setup();
        let older = repo.insert(&hook_row("s1", "cargo build", 1_000)).unwrap();
        let newer = repo.insert(&hook_row("s1", "cargo build", 2_000)).unwrap();
        assert!(repo
            .mark_target(
                "s1",
                "cargo build",
                "local",
                Some("gate: forced after timeout")
            )
            .unwrap());
        assert!(!repo
            .mark_target("s9", "cargo build", "local", None)
            .unwrap());

        let rows = repo.list(&HeavyCommandQuery::default()).unwrap();
        let find = |id: i64| rows.iter().find(|row| row.id == id).unwrap();
        assert_eq!(
            find(newer).offloaded_reason.as_deref(),
            Some("gate: forced after timeout")
        );
        assert_eq!(find(older).offloaded_reason, None);
    }

    #[test]
    fn finish_on_pruned_row_reports_false() {
        let repo = setup();
        assert!(!repo.finish(999, 1, None).unwrap());
    }

    #[test]
    fn merge_episode_overlapping_hook_row_becomes_both_and_keeps_hook_command() {
        let repo = setup();
        let id = repo.insert(&hook_row("s1", "cargo build", 1_000)).unwrap();
        // 还没 ToolAfter：ended_at NULL 视为"到现在"，episode 落在其中。
        let merged = repo.merge_episode(&episode("s1", 5_000, 20_000)).unwrap();
        assert_eq!(merged, id);

        let rows = repo.list(&HeavyCommandQuery::default()).unwrap();
        assert_eq!(rows.len(), 1, "must merge, not insert a second row");
        assert_eq!(rows[0].source, HeavyCommandSource::Both);
        assert_eq!(rows[0].cmd_normalized, "cargo build");
        assert_eq!(rows[0].peak_cpu_pct, Some(480.0));
        assert_eq!(rows[0].peak_mem_bytes, Some(3 * 1024 * 1024 * 1024));
        assert_eq!(rows[0].cpu_seconds, Some(120.5));

        // 第二段 episode：峰值取大、cpu_seconds 累加。
        let mut second = episode("s1", 21_000, 30_000);
        second.peak_cpu_pct = 100.0;
        second.cpu_seconds = 10.0;
        repo.merge_episode(&second).unwrap();
        let rows = repo.list(&HeavyCommandQuery::default()).unwrap();
        assert_eq!(rows[0].peak_cpu_pct, Some(480.0));
        assert_eq!(rows[0].cpu_seconds, Some(130.5));
    }

    #[test]
    fn merge_episode_without_overlap_inserts_sampler_row() {
        let repo = setup();
        let id = repo.insert(&hook_row("s1", "cargo build", 1_000)).unwrap();
        repo.finish(id, 2_000, Some(0)).unwrap();
        // 另一个会话 / 不重叠的时间窗
        repo.merge_episode(&episode("s2", 5_000, 20_000)).unwrap();
        repo.merge_episode(&episode("s1", 50_000, 60_000)).unwrap();

        let rows = repo.list(&HeavyCommandQuery::default()).unwrap();
        assert_eq!(rows.len(), 3);
        let sampler_rows = rows
            .iter()
            .filter(|row| row.source == HeavyCommandSource::Sampler)
            .count();
        assert_eq!(sampler_rows, 2);
        let s2 = rows.iter().find(|row| row.session_id == "s2").unwrap();
        assert_eq!(s2.cmd_normalized, "rustc");
        assert_eq!(s2.duration_ms, Some(15_000));
    }

    #[test]
    fn list_filters_by_project_and_since_and_limit() {
        let repo = setup();
        repo.insert(&hook_row("s1", "cargo build", 1_000)).unwrap();
        let mut other = hook_row("s2", "npm run build", 2_000);
        other.context.project_path = "E:/other".into();
        repo.insert(&other).unwrap();
        repo.insert(&hook_row("s1", "cargo test", 3_000)).unwrap();

        let by_project = repo
            .list(&HeavyCommandQuery {
                project_path: Some("D:/repo".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_project.len(), 2);

        let since = repo
            .list(&HeavyCommandQuery {
                since: Some(2_000),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(since.len(), 2);

        let limited = repo
            .list(&HeavyCommandQuery {
                limit: Some(1),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].cmd_normalized, "cargo test", "newest first");
    }

    #[test]
    fn aggregate_groups_by_normalized_command_with_percentiles() {
        let repo = setup();
        for (i, duration) in [10_000, 20_000, 30_000, 40_000, 100_000].iter().enumerate() {
            let started = 1_000 + i as i64 * 1_000_000;
            let id = repo
                .insert(&hook_row("s1", "cargo build", started))
                .unwrap();
            repo.finish(id, started + duration, Some(0)).unwrap();
        }
        repo.merge_episode(&episode("s9", 5, 6)).unwrap(); // rustc, 120.5 cpu-s
                                                           // 一条未封账行：计 runs，不计分位
        repo.insert(&hook_row("s1", "cargo build", 9_000_000))
            .unwrap();

        let aggregates = repo.aggregate(None, None).unwrap();
        assert_eq!(aggregates.len(), 2);
        // cpu_seconds 最高的排前面
        assert_eq!(aggregates[0].cmd_normalized, "rustc");
        assert_eq!(aggregates[0].total_cpu_seconds, 120.5);
        let build = &aggregates[1];
        assert_eq!(build.cmd_normalized, "cargo build");
        assert_eq!(build.runs, 6);
        assert_eq!(build.p50_duration_ms, Some(30_000));
        assert_eq!(build.p95_duration_ms, Some(40_000));
        assert_eq!(build.last_started_at, 9_000_000);

        let filtered = repo.aggregate(Some(4_000_000), None).unwrap();
        let build = filtered
            .iter()
            .find(|a| a.cmd_normalized == "cargo build")
            .unwrap();
        assert_eq!(build.runs, 2);
    }

    #[test]
    fn prune_removes_old_closed_and_stale_open_rows() {
        let repo = setup();
        let now = 100 * 24 * 60 * 60 * 1000;
        let old = repo
            .insert(&hook_row("s1", "cargo build", now - RETENTION_MS - 1))
            .unwrap();
        repo.finish(old, now - RETENTION_MS, Some(0)).unwrap();
        repo.insert(&hook_row("s1", "cargo test", now - OPEN_ROW_TTL_MS - 1))
            .unwrap();
        let recent_open = repo.insert(&hook_row("s1", "rg", now - 1_000)).unwrap();
        let recent_closed = repo
            .insert(&hook_row("s1", "git status", now - 5_000))
            .unwrap();
        repo.finish(recent_closed, now - 4_000, Some(0)).unwrap();

        assert_eq!(repo.prune(now).unwrap(), 2);
        let rows = repo.list(&HeavyCommandQuery::default()).unwrap();
        let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
        assert!(ids.contains(&recent_open));
        assert!(ids.contains(&recent_closed));
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn clear_all_empties_table() {
        let repo = setup();
        repo.insert(&hook_row("s1", "cargo build", 1)).unwrap();
        repo.insert(&hook_row("s1", "cargo test", 2)).unwrap();
        assert_eq!(repo.clear_all().unwrap(), 2);
        assert!(repo.list(&HeavyCommandQuery::default()).unwrap().is_empty());
    }

    #[test]
    fn session_context_reads_terminal_sessions_table() {
        let repo = setup();
        assert!(repo.session_context("nope").unwrap().is_none());
        repo.db
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO terminal_sessions
                    (session_id, tab_id, pane_id, project_path, workspace_name, cli_tool,
                     runtime_kind, created_at, saved_at)
                 VALUES ('s1', 't', 'p', 'D:/repo', 'ws', 'codex', 'wsl', 'now', 'now')",
                [],
            )
            .unwrap();
        let context = repo.session_context("s1").unwrap().unwrap();
        assert_eq!(
            context,
            HeavySessionContext {
                project_path: "D:/repo".into(),
                workspace: Some("ws".into()),
                cli_tool: "codex".into(),
                runtime_kind: "wsl".into(),
            }
        );
    }
}
