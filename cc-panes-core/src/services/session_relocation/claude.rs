//! Claude Code：`<projects>/<编码路径>/<sessionId>.jsonl`（+ 同名目录放 subagents / tool-results）。

use super::jsonl::{rewrite_jsonl, FieldPath};
use super::{
    copy_tree, recently_modified, set_mtime, Job, SessionRelocationReport, SkippedSession,
};
use crate::utils::claude_path::encode_claude_project_path;
use crate::utils::{AppError, AppResult};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Claude Code 超过这个长度的目录名会被截断加哈希，无法可靠推算。
const MAX_SLUG_LEN: usize = 200;
const SESSIONS_INDEX: &str = "sessions-index.json";

/// Claude Code 的目录名规则：每个 UTF-16 单元里非字母数字的都换成 `-`。
pub(super) fn claude_slug(path: &str) -> String {
    path.encode_utf16()
        .map(|unit| match char::from_u32(u32::from(unit)) {
            Some(c) if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect()
}

/// 候选目录名：Claude 的真实规则在前，CC-Panes 旧编码（只换 `:\/_`）兜底。
fn slug_candidates(path: &str) -> Vec<String> {
    let mut names = vec![claude_slug(path)];
    let legacy = encode_claude_project_path(path);
    if !names.contains(&legacy) {
        names.push(legacy);
    }
    names
}

fn pick_fields(value: &Value) -> Vec<FieldPath<'static>> {
    // `/cd` 产生的 relocated 行记录的是 relocatedCwd
    if value.get("type").and_then(Value::as_str) == Some("relocated") {
        vec![&["cwd"], &["relocatedCwd"]]
    } else {
        vec![&["cwd"]]
    }
}

pub(super) fn relocate(job: &Job<'_>, report: &mut SessionRelocationReport) -> AppResult<()> {
    for (index, projects) in job.roots.claude_projects_dirs.iter().enumerate() {
        if !projects.is_dir() {
            continue;
        }
        if claude_slug(&job.to).len() > MAX_SLUG_LEN {
            report.warnings.push(
                "Claude: the new path is too long for Claude Code's folder naming; skipped".into(),
            );
            return Ok(());
        }
        let target_dir = slug_candidates(&job.to)
            .into_iter()
            .map(|name| projects.join(name))
            .find(|dir| dir.is_dir())
            .unwrap_or_else(|| projects.join(claude_slug(&job.to)));
        for name in slug_candidates(&job.from) {
            let source_dir = projects.join(&name);
            if source_dir == target_dir || !is_real_dir(&source_dir) {
                continue;
            }
            let area = format!("claude/{index}/{name}");
            relocate_dir(job, &source_dir, &target_dir, &area, report)?;
        }
    }
    Ok(())
}

fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

struct Plan {
    sessions: Vec<(String, PathBuf, String)>, // (id, source jsonl, rewritten text)
    extras: Vec<PathBuf>,                     // memory/ 等非会话条目
}

fn relocate_dir(
    job: &Job<'_>,
    source_dir: &Path,
    target_dir: &Path,
    area: &str,
    report: &mut SessionRelocationReport,
) -> AppResult<()> {
    let plan = plan_dir(job, source_dir, target_dir, report)?;
    report.claude_sessions += plan.sessions.len();
    if job.dry_run || (plan.sessions.is_empty() && plan.extras.is_empty()) {
        return Ok(());
    }
    // 先整目录备份，再动任何文件。
    job.backup(area, Path::new(""), source_dir)?;
    std::fs::create_dir_all(target_dir)?;

    for (id, source, text) in &plan.sessions {
        let target = target_dir.join(format!("{id}.jsonl"));
        write_preserving_mtime(source, &target, text)?;
        let companion = source_dir.join(id);
        if companion.is_dir() {
            move_companion(job, &companion, &target_dir.join(id))?;
        }
        std::fs::remove_file(source)?;
    }
    for extra in &plan.extras {
        let Some(name) = extra.file_name() else {
            continue;
        };
        copy_tree(extra, &target_dir.join(name))?;
        remove_any(extra)?;
    }
    // 会话都搬走后，旧的 sessions-index.json 只会指向不存在的文件（已在备份里）。
    let index = source_dir.join(SESSIONS_INDEX);
    if index.is_file() && !has_sessions(source_dir) {
        std::fs::remove_file(&index)?;
    }
    if std::fs::read_dir(source_dir)?.next().is_none() {
        std::fs::remove_dir(source_dir)?;
    }
    Ok(())
}

fn plan_dir(
    job: &Job<'_>,
    source_dir: &Path,
    target_dir: &Path,
    report: &mut SessionRelocationReport,
) -> AppResult<Plan> {
    let mut plan = Plan {
        sessions: Vec::new(),
        extras: Vec::new(),
    };
    let mut entries: Vec<_> = std::fs::read_dir(source_dir)?.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in &entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".jsonl").filter(|_| path.is_file()) else {
            continue;
        };
        let skip = |reason: &str, report: &mut SessionRelocationReport| {
            report.skipped.push(SkippedSession {
                cli: "claude".into(),
                session_id: id.to_string(),
                reason: reason.into(),
            });
        };
        if target_dir.join(&name).exists() || target_dir.join(id).exists() {
            skip("exists", report);
            continue;
        }
        if recently_modified(&path, job.roots.active_window) {
            skip("active", report);
            continue;
        }
        let raw = std::fs::read_to_string(&path)?;
        match rewrite_jsonl(&raw, &job.from, &job.to, pick_fields) {
            Ok(rewritten) => plan.sessions.push((id.to_string(), path, rewritten.text)),
            Err(_) => skip("invalid", report),
        }
    }
    let session_ids: Vec<&str> = plan.sessions.iter().map(|(id, _, _)| id.as_str()).collect();
    let skipped_ids: Vec<&str> = report
        .skipped
        .iter()
        .filter(|item| item.cli == "claude")
        .map(|item| item.session_id.as_str())
        .collect();
    for entry in &entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".jsonl") || name == SESSIONS_INDEX {
            continue;
        }
        // 会话的同名目录跟着会话走
        if session_ids.contains(&name.as_str()) || skipped_ids.contains(&name.as_str()) {
            continue;
        }
        if target_dir.join(&name).exists() {
            report.warnings.push(format!(
                "Claude: '{name}' already exists under the new path; left in place"
            ));
            continue;
        }
        plan.extras.push(path);
    }
    Ok(plan)
}

fn has_sessions(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".jsonl"))
    })
}

fn write_preserving_mtime(source: &Path, target: &Path, text: &str) -> AppResult<()> {
    let modified = std::fs::metadata(source)?.modified().ok();
    crate::utils::atomic_file::write_atomic(target, text.as_bytes()).map_err(|error| {
        AppError::from(format!("Failed to write {}: {error}", target.display()))
    })?;
    if let Some(modified) = modified {
        set_mtime(target, modified);
    }
    Ok(())
}

/// 同名目录（subagents/*.jsonl 改写 cwd，其余原样）搬过去后删掉源。
fn move_companion(job: &Job<'_>, source: &Path, target: &Path) -> AppResult<()> {
    copy_tree(source, target)?;
    rewrite_subagents(job, &target.join("subagents"))?;
    remove_any(source)
}

fn rewrite_subagents(job: &Job<'_>, dir: &Path) -> AppResult<()> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let raw = std::fs::read_to_string(&path)?;
        // 子代理转录坏了不阻断主会话迁移，原样保留
        if let Ok(rewritten) = rewrite_jsonl(&raw, &job.from, &job.to, pick_fields) {
            if rewritten.changed > 0 {
                write_preserving_mtime(&path, &path, &rewritten.text)?;
            }
        }
    }
    Ok(())
}

fn remove_any(path: &Path) -> AppResult<()> {
    if std::fs::symlink_metadata(path)?.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}
