//! Cursor Agent 会话列表 — 从 `~/.cursor/chats/` 读取
//!
//! 目录布局（实机 cursor-agent 2026.08.25）：
//! ```text
//! ~/.cursor/chats/<project-hash>/<chat-uuid>/
//!   meta.json   { schemaVersion, createdAtMs, updatedAtMs, cwd, title?, hasConversation }
//!   store.db
//! ```
//! `chat-uuid` 即 `agent --resume <id>` 可用的 resume id。

use crate::utils::command::no_window_command;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Serialize, Clone)]
pub struct CursorSession {
    pub id: String,
    pub project_path: String,
    pub modified_at: u64,
    pub file_path: String,
    pub description: String,
    /// meta.json 的 createdAtMs（毫秒），用于「启动后新建」判定
    #[serde(default)]
    pub created_at_ms: Option<u64>,
}

fn cursor_chats_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".cursor").join("chats"))
}

pub(crate) fn paths_equal_loose(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim()
            .trim_end_matches(['/', '\\'])
            .replace('\\', "/")
            .to_ascii_lowercase()
    };
    norm(a) == norm(b)
}

fn ms_to_secs(ms: u64) -> u64 {
    ms / 1000
}

fn mtime_secs(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(
        modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()?
            .as_secs(),
    )
}

fn parse_meta(meta_path: &Path, chat_id: &str) -> Option<CursorSession> {
    let raw = fs::read_to_string(meta_path).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;

    let cwd = json
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();

    let title = json
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();

    let created_at_ms = json.get("createdAtMs").and_then(Value::as_u64);
    let modified_at = json
        .get("updatedAtMs")
        .and_then(Value::as_u64)
        .or(created_at_ms)
        .map(ms_to_secs)
        .or_else(|| mtime_secs(meta_path))?;

    Some(CursorSession {
        id: chat_id.to_string(),
        project_path: cwd,
        modified_at,
        file_path: meta_path.to_string_lossy().into_owned(),
        description: title,
        created_at_ms,
    })
}

pub(crate) fn collect_all(root: &Path) -> Vec<CursorSession> {
    let mut sessions = Vec::new();
    let Ok(project_dirs) = fs::read_dir(root) else {
        return sessions;
    };
    for project_entry in project_dirs.flatten() {
        let project_dir = project_entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let Ok(chat_dirs) = fs::read_dir(&project_dir) else {
            continue;
        };
        for chat_entry in chat_dirs.flatten() {
            let chat_dir = chat_entry.path();
            if !chat_dir.is_dir() {
                continue;
            }
            let chat_id = match chat_dir.file_name().and_then(|n| n.to_str()) {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => continue,
            };
            let meta_path = chat_dir.join("meta.json");
            if !meta_path.is_file() {
                continue;
            }
            if let Some(session) = parse_meta(&meta_path, &chat_id) {
                sessions.push(session);
            }
        }
    }
    sessions
}

/// 列出指定项目 cwd 下的 Cursor 会话（按 updatedAt 降序）。
pub fn list_sessions(project_path: &str, limit: usize) -> Result<Vec<CursorSession>, String> {
    let Some(root) = cursor_chats_root() else {
        return Ok(Vec::new());
    };
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut sessions: Vec<_> = collect_all(&root)
        .into_iter()
        .filter(|s| !s.project_path.is_empty() && paths_equal_loose(&s.project_path, project_path))
        .collect();
    sessions.sort_by_key(|s| std::cmp::Reverse(s.modified_at));
    sessions.truncate(limit);
    Ok(sessions)
}

/// 列出全部 Cursor 会话（按 updatedAt 降序）。
pub fn list_all_sessions(limit: usize) -> Result<Vec<CursorSession>, String> {
    let Some(root) = cursor_chats_root() else {
        return Ok(Vec::new());
    };
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut sessions = collect_all(&root);
    sessions.sort_by_key(|s| std::cmp::Reverse(s.modified_at));
    sessions.truncate(limit);
    Ok(sessions)
}

/// 在 `after` 之后、匹配 cwd 的最新 chat id（用于 launch 后 resume 落库）。
///
/// 容差：createdAtMs 允许比 after 早 2s（时钟/落盘抖动）。优先 createdAtMs，
/// 否则用 modified_at。同 cwd 多个候选取最新。
pub fn detect_session_after(
    project_path: &str,
    after: SystemTime,
) -> Result<Option<String>, String> {
    let Some(root) = cursor_chats_root() else {
        return Ok(None);
    };
    if !root.exists() {
        return Ok(None);
    }
    detect_in_sessions(&collect_all(&root), project_path, after)
}

pub(crate) fn detect_in_sessions(
    sessions: &[CursorSession],
    project_path: &str,
    after: SystemTime,
) -> Result<Option<String>, String> {
    let after_ms = after
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    // 2s 容差（毫秒）
    let after_relaxed_ms = after_ms.saturating_sub(2_000);

    let mut candidates: Vec<&CursorSession> = sessions
        .iter()
        .filter(|s| !s.project_path.is_empty() && paths_equal_loose(&s.project_path, project_path))
        .filter(|s| {
            let created_ms = s
                .created_at_ms
                .unwrap_or_else(|| s.modified_at.saturating_mul(1000));
            created_ms >= after_relaxed_ms
        })
        .collect();
    candidates.sort_by_key(|s| {
        std::cmp::Reverse(
            s.created_at_ms
                .unwrap_or_else(|| s.modified_at.saturating_mul(1000)),
        )
    });
    Ok(candidates.first().map(|s| s.id.clone()))
}

// ---- WSL ----

#[cfg(windows)]
fn resolve_wsl_distro(distro: Option<&str>) -> String {
    distro
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Ubuntu")
        .to_string()
}

#[cfg(windows)]
fn collect_wsl_sessions(limit: usize, distro: Option<&str>) -> Result<Vec<CursorSession>, String> {
    let distro = resolve_wsl_distro(distro);
    // 脚本走 stdin 避免 wsl argv 引号坑（见 CLAUDE.md gotcha）
    let script = r#"
set -e
ROOT="${HOME}/.cursor/chats"
LIMIT="${CCPANES_CURSOR_LIMIT:-50}"
python3 - <<'PY'
import json, os, sys
from pathlib import Path
root = Path(os.path.expanduser("~/.cursor/chats"))
limit = int(os.environ.get("CCPANES_CURSOR_LIMIT", "50"))
sessions = []
if root.is_dir():
    for meta in root.glob("*/*/meta.json"):
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
        except Exception:
            continue
        chat_id = meta.parent.name
        cwd = (data.get("cwd") or "").strip()
        title = (data.get("title") or "").strip()
        created = data.get("createdAtMs")
        updated = data.get("updatedAtMs") or created
        if updated is None:
            try:
                updated = int(meta.stat().st_mtime * 1000)
            except OSError:
                continue
        sessions.append({
            "id": chat_id,
            "project_path": cwd,
            "modified_at": int(updated) // 1000,
            "file_path": str(meta),
            "description": title,
            "created_at_ms": int(created) if created is not None else None,
        })
sessions.sort(key=lambda s: s["modified_at"], reverse=True)
for s in sessions[:limit]:
    print(json.dumps(s, ensure_ascii=False))
PY
"#;
    let mut cmd = no_window_command("wsl.exe");
    cmd.args(["-d", &distro, "--", "bash", "-lc", "bash -s"])
        .env("CCPANES_CURSOR_LIMIT", limit.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn WSL for cursor session scan: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(script.as_bytes())
            .map_err(|e| format!("Failed to write WSL cursor scan script: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("WSL cursor session scan failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "WSL cursor session scan failed: {}",
            stderr.trim()
        ));
    }
    parse_serialized_sessions(&String::from_utf8_lossy(&output.stdout))
}

fn parse_serialized_sessions(stdout: &str) -> Result<Vec<CursorSession>, String> {
    let mut sessions = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .map_err(|e| format!("Invalid cursor session JSON line: {e}"))?;
        let id = v
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        sessions.push(CursorSession {
            id,
            project_path: v
                .get("project_path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            modified_at: v.get("modified_at").and_then(Value::as_u64).unwrap_or(0),
            file_path: v
                .get("file_path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            description: v
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            created_at_ms: v.get("created_at_ms").and_then(Value::as_u64),
        });
    }
    Ok(sessions)
}

#[cfg(not(windows))]
fn collect_wsl_sessions(
    _limit: usize,
    _distro: Option<&str>,
) -> Result<Vec<CursorSession>, String> {
    Err("WSL Cursor session extraction is only supported on Windows hosts".to_string())
}

pub fn list_wsl_sessions(
    project_path: &str,
    limit: usize,
    distro: Option<&str>,
) -> Result<Vec<CursorSession>, String> {
    let mut sessions: Vec<_> = collect_wsl_sessions(limit.saturating_mul(4).max(limit), distro)?
        .into_iter()
        .filter(|s| !s.project_path.is_empty() && paths_equal_loose(&s.project_path, project_path))
        .collect();
    sessions.sort_by_key(|s| std::cmp::Reverse(s.modified_at));
    sessions.truncate(limit);
    Ok(sessions)
}

pub fn list_all_wsl_sessions(
    limit: usize,
    distro: Option<&str>,
) -> Result<Vec<CursorSession>, String> {
    collect_wsl_sessions(limit, distro)
}

/// WSL 侧 detect：after 用 Utc，cwd 可能是 /mnt/... 形式
pub fn detect_wsl_session_after(
    project_path: &str,
    after: DateTime<Utc>,
    distro: Option<&str>,
) -> Result<Option<String>, String> {
    let after_sys = SystemTime::UNIX_EPOCH
        + std::time::Duration::from_millis(after.timestamp_millis().max(0) as u64);
    let sessions = collect_wsl_sessions(200, distro)?;
    detect_in_sessions(&sessions, project_path, after_sys)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    fn test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn write_chat(root: &Path, project_hash: &str, chat_id: &str, meta: &str) {
        let dir = root.join(project_hash).join(chat_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("meta.json"), meta).unwrap();
    }

    #[test]
    fn list_sessions_filters_by_cwd_and_sorts() {
        let _guard = test_lock().lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("chats");
        write_chat(
            &root,
            "hash-a",
            "chat-new",
            r#"{"schemaVersion":1,"createdAtMs":2000000,"updatedAtMs":3000000,"hasConversation":true,"cwd":"D:\\work\\demo","title":"Newer"}"#,
        );
        write_chat(
            &root,
            "hash-a",
            "chat-old",
            r#"{"schemaVersion":1,"createdAtMs":1000000,"updatedAtMs":1500000,"hasConversation":true,"cwd":"D:/work/demo","title":"Older"}"#,
        );
        write_chat(
            &root,
            "hash-b",
            "chat-other",
            r#"{"schemaVersion":1,"createdAtMs":4000000,"updatedAtMs":5000000,"hasConversation":true,"cwd":"D:\\other","title":"Other"}"#,
        );

        let mut all = collect_all(&root);
        all.retain(|s| paths_equal_loose(&s.project_path, r"D:\work\demo"));
        all.sort_by_key(|s| std::cmp::Reverse(s.modified_at));
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "chat-new");
        assert_eq!(all[0].description, "Newer");
        assert_eq!(all[0].modified_at, 3000);
        assert_eq!(all[1].id, "chat-old");
    }

    #[test]
    fn detect_session_after_picks_newest_matching_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("chats");
        // after = 2500ms epoch → only chat-new qualifies
        write_chat(
            &root,
            "h",
            "chat-old",
            r#"{"schemaVersion":1,"createdAtMs":1000,"updatedAtMs":1000,"cwd":"D:\\work\\demo"}"#,
        );
        write_chat(
            &root,
            "h",
            "chat-new",
            r#"{"schemaVersion":1,"createdAtMs":5000,"updatedAtMs":6000,"cwd":"D:\\work\\demo"}"#,
        );
        let after = SystemTime::UNIX_EPOCH + Duration::from_millis(2500);
        let id = detect_in_sessions(&collect_all(&root), r"D:\work\demo", after)
            .unwrap()
            .expect("should find chat-new");
        assert_eq!(id, "chat-new");
    }

    #[test]
    fn paths_equal_loose_handles_separators() {
        assert!(paths_equal_loose(r"D:\a\b", "D:/a/b"));
        assert!(!paths_equal_loose(r"D:\a\b", r"D:\a\c"));
    }

    #[test]
    fn parse_serialized_sessions_round_trip() {
        let line = r#"{"id":"abc","project_path":"/tmp/p","modified_at":10,"file_path":"/x","description":"t","created_at_ms":10000}"#;
        let sessions = parse_serialized_sessions(line).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "abc");
        assert_eq!(sessions[0].created_at_ms, Some(10000));
    }
}
