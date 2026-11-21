//! 项目级 MCP 文件的落盘细节（docs/110 批 2）：JSON / TOML 同步、git 排除、会话租约。
//!
//! JSON 走 [`crate::mcp_file_injection::sync_project_mcp_json`]（omp / jcode 已验证过的收据
//! 流程）；TOML（Grok `.grok/config.toml`）在这里用 `toml_edit` 实现同一套契约：保留用户
//! 注释与格式、只动收据里的条目、同名用户条目跳过、解析失败原样保留、语义不变零写入。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use serde_json::{json, Value};
use toml_edit::{DocumentMut, InlineTable, Item, Table};
use tracing::warn;

use crate::mcp_file_injection::{self as receipts, McpFileSyncOutcome};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileFormat {
    Json,
    Toml,
}

/// 一个 CLI 的项目级配置文件位置与格式。
#[derive(Debug, Clone, Copy)]
pub struct ProjectTarget {
    pub cli_id: &'static str,
    /// 相对项目根的路径段（`[".kimi-code", "mcp.json"]`）。
    pub rel: &'static [&'static str],
    pub format: FileFormat,
    /// server 表的顶层键（`mcpServers` / `mcp_servers`）。
    pub servers_key: &'static str,
    /// 在工具目录写 `.gitignore` 守卫（omp / jcode 的既有行为；新接入一律靠 `.git/info/exclude`）。
    pub tool_dir_guard: bool,
}

impl ProjectTarget {
    pub fn path(&self, project: &Path) -> PathBuf {
        self.rel
            .iter()
            .fold(project.to_path_buf(), |acc, part| acc.join(part))
    }

    fn rel_string(&self) -> String {
        self.rel.join("/")
    }
}

#[derive(Debug, Default)]
pub struct SyncOutcome {
    pub written: bool,
    pub injected: usize,
    pub removed: usize,
    /// 目标文件已被 git 跟踪：不写（否则会弄脏用户的仓库）。
    pub skipped_tracked: bool,
}

/// 把 desired 同步进项目文件；写入后把它（与 `.bak`）加进 `.git/info/exclude`。
pub fn sync(
    target: &ProjectTarget,
    project: &Path,
    desired: &BTreeMap<String, Value>,
) -> Result<SyncOutcome> {
    let path = target.path(project);
    if path.is_file() && is_git_tracked(project, &target.rel_string()) {
        warn!(
            cli_id = target.cli_id,
            file = %path.display(),
            "project MCP: target file is tracked by git, leaving it untouched"
        );
        return Ok(SyncOutcome {
            skipped_tracked: true,
            ..SyncOutcome::default()
        });
    }
    let outcome = match target.format {
        FileFormat::Json => receipts::sync_project_mcp_json(
            target.cli_id,
            project,
            target.rel,
            target.servers_key,
            desired,
            target.tool_dir_guard,
        )?,
        FileFormat::Toml => sync_toml(target, project, &path, desired)?,
    };
    if outcome.written {
        ensure_git_excluded(project, &target.rel_string());
    }
    Ok(SyncOutcome {
        written: outcome.written,
        injected: outcome.injected,
        removed: outcome.removed,
        skipped_tracked: false,
    })
}

fn sync_toml(
    target: &ProjectTarget,
    project: &Path,
    path: &Path,
    desired: &BTreeMap<String, Value>,
) -> Result<McpFileSyncOutcome> {
    let receipt = receipts::receipt_path(project, target.cli_id);
    let owned = receipts::read_receipt(&receipt);
    let original = match fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    if original.is_none() && desired.is_empty() && owned.is_empty() {
        return Ok(McpFileSyncOutcome::default());
    }
    let mut doc = match original.as_deref().unwrap_or("").parse::<DocumentMut>() {
        Ok(doc) => doc,
        Err(error) => {
            warn!(file = %path.display(), %error, "project MCP: TOML is invalid, leaving it untouched");
            return Ok(McpFileSyncOutcome::default());
        }
    };
    let Some(servers) = doc
        .entry(target.servers_key)
        .or_insert_with(|| {
            // 只用作 `[mcp_servers.<name>]` 的父表，不单独渲染一个空的 `[mcp_servers]`
            let mut table = Table::new();
            table.set_implicit(true);
            Item::Table(table)
        })
        .as_table_like_mut()
    else {
        warn!(file = %path.display(), "project MCP: server table is not a table, leaving it untouched");
        return Ok(McpFileSyncOutcome::default());
    };
    let mut outcome = McpFileSyncOutcome::default();
    for name in &owned {
        match desired.get(name) {
            Some(value) => {
                servers.insert(name, json_to_table(value));
                outcome.injected += 1;
            }
            None => {
                if servers.remove(name).is_some() {
                    outcome.removed += 1;
                }
            }
        }
    }
    for (name, value) in desired {
        if owned.contains(name) {
            continue;
        }
        if servers.get(name).is_some() {
            warn!(server = %name, "project MCP: name collides with a user-owned entry, leaving it untouched");
            outcome.foreign_collisions.push(name.clone());
            continue;
        }
        servers.insert(name, json_to_table(value));
        outcome.injected += 1;
    }
    let next_owned: BTreeSet<String> = desired
        .keys()
        .filter(|name| !outcome.foreign_collisions.contains(name))
        .cloned()
        .collect();
    let updated = doc.to_string();
    let unchanged = original.as_deref().unwrap_or("") == updated;
    if unchanged && next_owned == owned {
        outcome.injected = 0;
        return Ok(outcome);
    }
    if !unchanged {
        if original.is_some() {
            let _ = fs::copy(path, path.with_extension("toml.bak"));
        }
        crate::fs_atomic::write_atomic(path, updated)
            .with_context(|| format!("write {}", path.display()))?;
        outcome.written = true;
    }
    receipts::write_receipt(&receipt, &next_owned, project)?;
    Ok(outcome)
}

/// JSON 条目 → TOML 表：标量与字符串数组原样，嵌套对象（env / headers）为内联表。
fn json_to_table(value: &Value) -> Item {
    let mut table = Table::new();
    if let Some(object) = value.as_object() {
        for (key, field) in object {
            if let Some(item) = json_to_value(field) {
                table.insert(key, Item::Value(item));
            }
        }
    }
    Item::Table(table)
}

fn json_to_value(value: &Value) -> Option<toml_edit::Value> {
    match value {
        Value::String(text) => Some(text.as_str().into()),
        Value::Bool(flag) => Some((*flag).into()),
        Value::Number(number) => number.as_i64().map(Into::into),
        Value::Array(items) => {
            let mut array = toml_edit::Array::new();
            for item in items.iter().filter_map(json_to_value) {
                array.push(item);
            }
            Some(toml_edit::Value::Array(array))
        }
        Value::Object(map) => {
            let mut inline = InlineTable::new();
            for (key, field) in map {
                if let Some(item) = json_to_value(field) {
                    inline.insert(key, item);
                }
            }
            Some(toml_edit::Value::InlineTable(inline))
        }
        Value::Null => None,
    }
}

// ---------------------------------------------------------------------------
// git：已跟踪的不写，写了就排除
// ---------------------------------------------------------------------------

fn git(project: &Path, args: &[&str]) -> Option<std::process::Output> {
    if !project.is_dir() {
        return None;
    }
    let mut command = crate::no_window_command("git");
    command
        .args(args)
        .current_dir(project)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    command.output().ok()
}

fn is_git_tracked(project: &Path, rel: &str) -> bool {
    git(project, &["ls-files", "--error-unmatch", "--", rel])
        .is_some_and(|output| output.status.success())
}

/// 把 `<rel>` 与 `<rel>.bak` 加进仓库的 `info/exclude`（worktree 也落在共享的 common dir）。
/// 不是 git 仓库 / 没装 git 时什么都不做。
fn ensure_git_excluded(project: &Path, rel: &str) {
    let Some(output) = git(
        project,
        &["rev-parse", "--show-prefix", "--git-path", "info/exclude"],
    )
    .filter(|output| output.status.success()) else {
        return;
    };
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut lines = text.lines();
    let (Some(prefix), Some(exclude)) = (lines.next(), lines.next()) else {
        return;
    };
    let exclude = {
        let path = PathBuf::from(exclude.trim());
        if path.is_absolute() {
            path
        } else {
            project.join(path)
        }
    };
    let patterns = [format!("/{prefix}{rel}"), format!("/{prefix}{rel}.bak")];
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    let missing: Vec<&String> = patterns
        .iter()
        .filter(|pattern| !existing.lines().any(|line| line.trim() == pattern.as_str()))
        .collect();
    if missing.is_empty() {
        return;
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# CC-Panes: per-session MCP config (docs/110), never commit\n");
    for pattern in missing {
        next.push_str(pattern);
        next.push('\n');
    }
    if let Some(parent) = exclude.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::write(&exclude, next) {
        warn!(file = %exclude.display(), %error, "project MCP: failed to extend .git/info/exclude");
    }
}

// ---------------------------------------------------------------------------
// 会话租约：最后一个会话结束时才清理同项目的共享文件
// ---------------------------------------------------------------------------

/// 崩溃遗留的租约最多挡这么久的清理（与退休配置的保留期一致）。
const LEASE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn leases_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("cli-adapters").join("project-mcp-leases")
}

fn lease_path(data_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let safe = !session_id.is_empty()
        && session_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    safe.then(|| leases_dir(data_dir).join(format!("{session_id}.json")))
}

pub fn write_lease(data_dir: &Path, session_id: &str, cli_id: &str, project: &Path) {
    let Some(path) = lease_path(data_dir, session_id) else {
        return;
    };
    let body = json!({ "cliId": cli_id, "projectPath": project.to_string_lossy() });
    let written =
        fs::create_dir_all(leases_dir(data_dir)).and_then(|_| fs::write(&path, body.to_string()));
    if let Err(error) = written {
        warn!(%error, "project MCP: failed to record session lease");
    }
}

fn read_lease(path: &Path) -> Option<(String, PathBuf)> {
    let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    Some((
        value.get("cliId")?.as_str()?.to_string(),
        PathBuf::from(value.get("projectPath")?.as_str()?),
    ))
}

/// 取走本会话的租约（读出后删除）。
pub fn take_lease(data_dir: &Path, session_id: &str) -> Option<(String, PathBuf)> {
    let path = lease_path(data_dir, session_id)?;
    let lease = read_lease(&path)?;
    let _ = fs::remove_file(&path);
    Some(lease)
}

pub fn has_other_lease(data_dir: &Path, cli_id: &str, project: &Path) -> bool {
    let Ok(entries) = fs::read_dir(leases_dir(data_dir)) else {
        return false;
    };
    let now = SystemTime::now();
    entries.flatten().any(|entry| {
        let fresh = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age < LEASE_TTL);
        fresh
            && read_lease(&entry.path()).is_some_and(|(other_cli, other_project)| {
                other_cli == cli_id && other_project == project
            })
    })
}
