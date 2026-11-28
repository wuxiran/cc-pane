//! 项目目录移动 / 改名后迁移历史会话（docs/115 §2，参照 magpie `relocate_claude.go`）。
//!
//! - Claude Code：会话存在 `<projects>/<编码后的项目路径>/`。把旧目录里的会话逐个搬到新编码目录，
//!   只改写每行顶层的 `cwd`（以及 `/cd` 产生的 `relocatedCwd`），消息内容一律不动。
//!   新目录下已有同名会话时跳过并报告。
//! - Codex：会话按日期存在 `sessions/YYYY/MM/DD/rollout-*.jsonl`，路径不参与寻址。
//!   只改写 `session_meta` / `turn_context` 行 `payload.cwd`，文件原地改写并保留 mtime。
//! - CC-Panes 自己的 `launch_history.project_path / launch_cwd`、`task_bindings.project_path`。
//!
//! 所有改写都只碰「等于旧路径或以旧路径 + 分隔符开头」的字段。执行前先把要动的原件
//! 备份到 `<data>/backups/session-relocation/<时间戳>/`。`dry_run` 只统计不落盘。
//! 根目录全部由 [`RelocationRoots`] 传入，测试用临时目录，绝不碰真实的 `~/.claude` / `~/.codex`。

mod claude;
mod codex;
mod jsonl;
mod records;
#[cfg(test)]
mod tests;

use crate::utils::{AppError, AppPaths, AppResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 最近这么久内被写过的会话视为可能还开着，跳过（magpie 同口径）。
pub const DEFAULT_ACTIVE_WINDOW: Duration = Duration::from_secs(60);

/// 迁移涉及的根目录。生产环境由 [`RelocationRoots::detect`] 给出，测试直接构造。
#[derive(Debug, Clone)]
pub struct RelocationRoots {
    /// Claude 的 `projects` 目录（默认目录 + 各登录账号目录）。
    pub claude_projects_dirs: Vec<PathBuf>,
    /// Codex 的 `sessions` 目录（默认目录 + 各登录账号目录）。
    pub codex_sessions_dirs: Vec<PathBuf>,
    /// 备份根：`<data>/backups/session-relocation`。
    pub backup_root: PathBuf,
    pub active_window: Duration,
}

impl RelocationRoots {
    pub fn detect(app_paths: &AppPaths) -> Self {
        let mut roots = Self::detect_without_paths();
        roots.backup_root = backup_root_for(app_paths.data_dir());
        roots
    }

    fn detect_without_paths() -> Self {
        Self {
            claude_projects_dirs: crate::services::claude_session_service::claude_projects_roots()
                .into_iter()
                .map(|root| root.dir)
                .collect(),
            codex_sessions_dirs: crate::services::codex_session_service::codex_sessions_roots()
                .into_iter()
                .map(|root| root.dir)
                .collect(),
            backup_root: PathBuf::new(),
            active_window: DEFAULT_ACTIVE_WINDOW,
        }
    }
}

pub fn backup_root_for(data_dir: &Path) -> PathBuf {
    data_dir.join("backups").join("session-relocation")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRelocationRequest {
    pub old_path: String,
    pub new_path: String,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSession {
    /// `claude` / `codex`
    pub cli: String,
    pub session_id: String,
    /// `exists`（新路径下已有同名会话）/ `active`（刚被写过）/ `invalid`（文件不是合法 JSONL）
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRelocationReport {
    pub dry_run: bool,
    pub old_path: String,
    pub new_path: String,
    /// 会迁移（dry-run）/ 已迁移的 Claude 会话数。
    pub claude_sessions: usize,
    /// 会改写 / 已改写的 Codex 会话数。
    pub codex_sessions: usize,
    pub skipped: Vec<SkippedSession>,
    pub launch_history_rows: usize,
    pub task_binding_rows: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_dir: Option<String>,
    pub warnings: Vec<String>,
}

/// 规整成干净的绝对路径：去掉首尾空白和末尾分隔符。
fn clean_path(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    let stripped = trimmed.trim_end_matches(['/', '\\']);
    // 根目录（`/`、`C:\`）不允许作为迁移端点
    if stripped.is_empty() || stripped.ends_with(':') {
        return Err(AppError::from(
            "Use a project directory, not a drive or filesystem root",
        ));
    }
    if !Path::new(stripped).is_absolute() && !looks_like_windows_absolute(stripped) {
        return Err(AppError::from(format!("Not an absolute path: {stripped}")));
    }
    if stripped.contains(['\0', '\n', '\r']) {
        return Err(AppError::from("Path contains control characters"));
    }
    Ok(stripped.to_string())
}

fn looks_like_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// `value` 等于 `from` 或位于 `from` 之下时，换成 `to` 前缀；否则不动。
pub fn remap_path(value: &str, from: &str, to: &str) -> Option<String> {
    if value == from {
        return Some(to.to_string());
    }
    let rest = value.strip_prefix(from)?;
    if rest.starts_with('/') || rest.starts_with('\\') {
        return Some(format!("{to}{rest}"));
    }
    None
}

/// 一次迁移的上下文（规整后的路径 + 根 + 可选的备份目录）。
pub(super) struct Job<'a> {
    pub from: String,
    pub to: String,
    pub roots: &'a RelocationRoots,
    pub dry_run: bool,
    pub backup_dir: PathBuf,
}

impl Job<'_> {
    /// 把原件拷进备份目录（`<backup>/<area>/<rel>`）。
    pub fn backup(&self, area: &str, rel: &Path, source: &Path) -> AppResult<()> {
        let target = self.backup_dir.join(area).join(rel);
        copy_tree(source, &target)
    }
}

/// 递归复制（文件 / 目录），保留 mtime。不跟随符号链接。
pub(super) fn copy_tree(source: &Path, target: &Path) -> AppResult<()> {
    let meta = std::fs::symlink_metadata(source)?;
    if meta.file_type().is_symlink() {
        return Err(AppError::from(format!(
            "Refusing to copy symbolic link {}",
            source.display()
        )));
    }
    if meta.is_dir() {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(source, target)?;
    if let Ok(modified) = meta.modified() {
        set_mtime(target, modified);
    }
    Ok(())
}

pub(super) fn set_mtime(path: &Path, modified: std::time::SystemTime) {
    if let Ok(file) = std::fs::File::options().write(true).open(path) {
        let _ = file.set_modified(modified);
    }
}

pub(super) fn recently_modified(path: &Path, window: Duration) -> bool {
    if window.is_zero() {
        return false;
    }
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < window)
}

/// 预览或执行一次会话迁移。`db` 为 `None` 时不碰 CC-Panes 自己的记录（测试 / 无库场景）。
pub fn relocate_sessions(
    roots: &RelocationRoots,
    db: Option<&Connection>,
    request: &SessionRelocationRequest,
) -> AppResult<SessionRelocationReport> {
    let from = clean_path(&request.old_path)?;
    let to = clean_path(&request.new_path)?;
    if from == to {
        return Err(AppError::from("The old and new paths are the same"));
    }
    if remap_path(&to, &from, &to).is_some() || remap_path(&from, &to, &from).is_some() {
        return Err(AppError::from(
            "The new path must not be inside the old path (or the other way round)",
        ));
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f").to_string();
    let job = Job {
        from,
        to,
        roots,
        dry_run: request.dry_run,
        backup_dir: roots.backup_root.join(stamp),
    };
    let mut report = SessionRelocationReport {
        dry_run: request.dry_run,
        old_path: job.from.clone(),
        new_path: job.to.clone(),
        ..Default::default()
    };

    claude::relocate(&job, &mut report)?;
    codex::relocate(&job, &mut report)?;
    if let Some(conn) = db {
        records::relocate(&job, conn, &mut report)?;
    }
    if !job.dry_run && job.backup_dir.exists() {
        write_manifest(&job, &report)?;
        report.backup_dir = Some(job.backup_dir.to_string_lossy().into_owned());
    }
    Ok(report)
}

fn write_manifest(job: &Job<'_>, report: &SessionRelocationReport) -> AppResult<()> {
    let body = serde_json::to_string_pretty(report)
        .map_err(|error| AppError::from(format!("Failed to serialize manifest: {error}")))?;
    std::fs::write(job.backup_dir.join("manifest.json"), body)?;
    Ok(())
}

/// 桌面端用的薄封装：根目录按当前环境探测，CC-Panes 记录走主库。
pub struct SessionRelocationService {
    data_dir: PathBuf,
    db: std::sync::Arc<crate::repository::Database>,
}

impl SessionRelocationService {
    pub fn new(app_paths: &AppPaths, db: std::sync::Arc<crate::repository::Database>) -> Self {
        Self {
            data_dir: app_paths.data_dir().to_path_buf(),
            db,
        }
    }

    pub fn relocate(
        &self,
        request: &SessionRelocationRequest,
    ) -> AppResult<SessionRelocationReport> {
        let mut roots = RelocationRoots::detect_without_paths();
        roots.backup_root = backup_root_for(&self.data_dir);
        let conn = self.db.connection()?;
        let report = relocate_sessions(&roots, Some(&conn), request)?;
        tracing::info!(
            dry_run = report.dry_run,
            claude = report.claude_sessions,
            codex = report.codex_sessions,
            skipped = report.skipped.len(),
            launch_history = report.launch_history_rows,
            task_bindings = report.task_binding_rows,
            "session relocation"
        );
        Ok(report)
    }
}
