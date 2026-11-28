//! Codex：`sessions/YYYY/MM/DD/rollout-*.jsonl`，按 `session_meta.payload.cwd` 认领。
//! 只改 `session_meta` / `turn_context` 行的 `payload.cwd`，文件原地改写、保留 mtime。

use super::jsonl::{rewrite_jsonl, FieldPath};
use super::{
    recently_modified, remap_path, set_mtime, Job, SessionRelocationReport, SkippedSession,
};
use crate::utils::{AppError, AppResult};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn pick_fields(value: &Value) -> Vec<FieldPath<'static>> {
    match value.get("type").and_then(Value::as_str) {
        Some("session_meta") | Some("turn_context") => vec![&["payload", "cwd"]],
        _ => Vec::new(),
    }
}

/// 文件头几行里首个 `session_meta` 的 (id, cwd)。只读开头，不整份加载。
fn session_meta(path: &Path) -> Option<(String, String)> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    reader
        .lines()
        .map_while(Result::ok)
        .filter(|line| !line.trim().is_empty())
        .take(5)
        .find_map(|line| {
            let value: Value = serde_json::from_str(&line).ok()?;
            if value.get("type")?.as_str()? != "session_meta" {
                return None;
            }
            let payload = value.get("payload")?;
            Some((
                payload.get("id")?.as_str()?.to_string(),
                payload.get("cwd")?.as_str()?.to_string(),
            ))
        })
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            collect_jsonl(&path, out);
        } else if kind.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

pub(super) fn relocate(job: &Job<'_>, report: &mut SessionRelocationReport) -> AppResult<()> {
    for (index, root) in job.roots.codex_sessions_dirs.iter().enumerate() {
        let mut files = Vec::new();
        collect_jsonl(root, &mut files);
        files.sort();
        for path in files {
            relocate_file(job, index, root, &path, report)?;
        }
    }
    Ok(())
}

fn relocate_file(
    job: &Job<'_>,
    index: usize,
    root: &Path,
    path: &Path,
    report: &mut SessionRelocationReport,
) -> AppResult<()> {
    let Some((id, cwd)) = session_meta(path) else {
        return Ok(());
    };
    if remap_path(&cwd, &job.from, &job.to).is_none() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(path)?;
    let skip = |reason: &str, report: &mut SessionRelocationReport| {
        report.skipped.push(SkippedSession {
            cli: "codex".into(),
            session_id: id.clone(),
            reason: reason.into(),
        });
    };
    if recently_modified(path, job.roots.active_window) {
        skip("active", report);
        return Ok(());
    }
    let rewritten = match rewrite_jsonl(&raw, &job.from, &job.to, pick_fields) {
        Ok(rewritten) => rewritten,
        Err(_) => {
            skip("invalid", report);
            return Ok(());
        }
    };
    report.codex_sessions += 1;
    if job.dry_run {
        return Ok(());
    }
    let rel = path.strip_prefix(root).unwrap_or(path);
    job.backup(&format!("codex/{index}"), rel, path)?;
    let modified = std::fs::metadata(path)?.modified().ok();
    crate::utils::atomic_file::write_atomic(path, rewritten.text.as_bytes())
        .map_err(|error| AppError::from(format!("Failed to write {}: {error}", path.display())))?;
    if let Some(modified) = modified {
        set_mtime(path, modified);
    }
    Ok(())
}
