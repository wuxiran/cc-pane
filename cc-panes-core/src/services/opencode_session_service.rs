//! OpenCode Session Service — 从 OpenCode SQLite 数据库读取历史会话
//!
//! OpenCode TUI 不像 Codex 一样输出 OSC thread id，交互会话需要靠项目路径和时间反查。
//!
//! 接口形态刻意与 `codex_session_service` 对齐（`list_sessions` / `list_all_sessions` /
//! `detect_session` + 各自的 `*_wsl_*` 变体），调用方按同一套模式接即可。
//!
//! 来源：从 `feat/opencode-parity` 分支（2026-06，5 周未合）**逐项抽取**而非整分支合并。
//! 那条分支的 `opencode.rs` 停在 761 行，而 main 上同一文件已迭代到 1121 行
//! （transparent theme、legacy theme channel 等 4 次后续修复），整分支合会把这些抹掉。
//! 该分支 27 个文件里 main 已有 24 个更新版本，只有本文件与前端的
//! `opencodeService.ts` 是 main 真正缺失的能力。

use chrono::Utc;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::utils::no_window_command;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct OpenCodeSession {
    pub id: String,
    pub project_path: String,
    pub modified_at: u64,
    pub file_path: String,
    pub description: String,
}

/// 归一化项目路径用于会话匹配。OpenCode TUI 启动后靠项目路径反查会话，注册路径可能是
/// Windows 盘符（`D:\x`）、WSL UNC（`\\wsl.localhost\Ubuntu\mnt\d\x`）或 WSL 内 POSIX
/// （`/mnt/d/x`、`/home/...`），而 opencode.db 里的目录是 POSIX 形态。这里把各形态统一到
/// WSL 视角的 POSIX 路径再 lowercase，否则 WSL-UNC 注册的项目会匹配不上 `/mnt/...` 会话目录。
fn normalize_compare_path(path: &str) -> String {
    let stripped = strip_extended_length_prefix(path);
    let slashed = stripped.replace('\\', "/");

    // WSL UNC（//wsl.localhost/<distro>/… | //wsl$/<distro>/… | //wsl/<distro>/…）
    // → 取 distro 内的 POSIX 绝对路径。
    if let Some(rest) = strip_wsl_unc_prefix(&slashed) {
        return rest.trim_end_matches('/').to_lowercase();
    }
    if let Some(mnt) = drive_to_mnt_path(&slashed) {
        return mnt.trim_end_matches('/').to_lowercase();
    }
    slashed.trim_end_matches('/').to_lowercase()
}

/// 剥离 Windows 扩展长度前缀：`\\?\UNC\server\share` → `\\server\share`；`\\?\D:\x` → `D:\x`。
fn strip_extended_length_prefix(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.starts_with(r"\\?\unc\") {
        return format!(r"\\{}", &path[r"\\?\UNC\".len()..]);
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

/// 识别 WSL UNC 主机（wsl.localhost / wsl$ / wsl）并返回 distro 内的 POSIX 路径（含前导 `/`）。
/// 入参须已把 `\` 转 `/`。非 WSL 主机返回 None。
fn strip_wsl_unc_prefix(slashed: &str) -> Option<&str> {
    let rest = slashed.strip_prefix("//")?;
    let lower = rest.to_ascii_lowercase();
    let is_wsl_host = lower.starts_with("wsl.localhost/")
        || lower.starts_with("wsl$/")
        || lower.starts_with("wsl/");
    if !is_wsl_host {
        return None;
    }
    let host_slash = rest.find('/')?;
    let after_host = &rest[host_slash + 1..];
    let distro_slash = after_host.find('/')?;
    Some(&after_host[distro_slash..])
}

fn drive_to_mnt_path(slashed: &str) -> Option<String> {
    let bytes = slashed.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        let drive = bytes[0].to_ascii_lowercase() as char;
        return Some(format!("/mnt/{}{}", drive, &slashed[2..]));
    }
    None
}

fn default_data_dir() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("OPENCODE_DATA_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(value));
    }
    dirs::home_dir()
        .map(|home| home.join(".local").join("share").join("opencode"))
        .ok_or_else(|| "Failed to get user home directory".to_string())
}

fn default_db_path() -> Result<PathBuf, String> {
    Ok(default_data_dir()?.join("opencode.db"))
}

fn open_readonly_connection(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|error| {
        format!(
            "Failed to open OpenCode database {}: {}",
            path.display(),
            error
        )
    })
}

fn session_description_from_db(conn: &Connection, session_id: &str, fallback: &str) -> String {
    let mut stmt = match conn.prepare(
        r#"
        SELECT data
        FROM part
        WHERE session_id = ?1
        ORDER BY time_created ASC
        LIMIT 80
        "#,
    ) {
        Ok(stmt) => stmt,
        Err(_) => return fallback.to_string(),
    };

    let rows = match stmt.query_map([session_id], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows,
        Err(_) => return fallback.to_string(),
    };

    for data in rows.flatten() {
        let Ok(json) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if json.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = json.get("text").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if should_skip_description(text) {
            continue;
        }
        return truncate_description(text);
    }

    fallback.to_string()
}

fn should_skip_description(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.len() < 3 || trimmed == "继续" || trimmed.eq_ignore_ascii_case("continue")
}

fn truncate_description(text: &str) -> String {
    let desc: String = text.chars().take(80).collect();
    if desc.len() < text.len() {
        format!("{}...", desc)
    } else {
        desc
    }
}

fn millis_to_secs(value: i64) -> u64 {
    if value <= 0 {
        return 0;
    }
    if value > 10_000_000_000 {
        (value / 1000) as u64
    } else {
        value as u64
    }
}

fn db_file_path(path: &Path, session_id: &str) -> String {
    format!("{}#session:{}", path.display(), session_id)
}

#[cfg(windows)]
fn parse_serialized_sessions(stdout: &str) -> Result<Vec<OpenCodeSession>, String> {
    let mut sessions = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let session: OpenCodeSession = serde_json::from_str(trimmed)
            .map_err(|error| format!("Failed to parse WSL OpenCode session payload: {}", error))?;
        sessions.push(session);
    }
    Ok(sessions)
}

#[cfg(windows)]
fn resolve_wsl_distro(distro: Option<&str>) -> Result<String, String> {
    if let Some(distro) = distro.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(distro.to_string());
    }

    crate::services::wsl_discovery_service::resolve_default_distro()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "No default WSL distro found".to_string())
}

pub fn list_all_sessions(limit: usize) -> Result<Vec<OpenCodeSession>, String> {
    list_all_sessions_from_db(&default_db_path()?, limit)
}

fn list_all_sessions_from_db(path: &Path, limit: usize) -> Result<Vec<OpenCodeSession>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let conn = open_readonly_connection(path)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                session.id,
                COALESCE(NULLIF(project.worktree, ''), NULLIF(session.directory, ''), '/') AS project_path,
                session.title,
                session.time_updated
            FROM session
            LEFT JOIN project ON project.id = session.project_id
            WHERE session.time_archived IS NULL
            ORDER BY session.time_updated DESC
            LIMIT ?1
            "#,
        )
        .map_err(|error| format!("Failed to prepare OpenCode session query: {}", error))?;

    let rows = stmt
        .query_map([limit as i64], |row| {
            let id: String = row.get(0)?;
            let project_path: String = row.get(1)?;
            let title: String = row.get(2)?;
            let time_updated: i64 = row.get(3)?;
            Ok((id, project_path, title, time_updated))
        })
        .map_err(|error| format!("Failed to query OpenCode sessions: {}", error))?;

    let mut sessions = Vec::new();
    for row in rows {
        let (id, project_path, title, time_updated) =
            row.map_err(|error| format!("Failed to read OpenCode session row: {}", error))?;
        let description = session_description_from_db(&conn, &id, &title);
        sessions.push(OpenCodeSession {
            id: id.clone(),
            project_path,
            modified_at: millis_to_secs(time_updated),
            file_path: db_file_path(path, &id),
            description,
        });
    }

    Ok(sessions)
}

fn filter_sessions(
    sessions: Vec<OpenCodeSession>,
    project_path: &str,
    limit: usize,
) -> Vec<OpenCodeSession> {
    let target = normalize_compare_path(project_path);
    let mut filtered = sessions
        .into_iter()
        .filter(|session| normalize_compare_path(&session.project_path) == target)
        .collect::<Vec<_>>();
    filtered.truncate(limit);
    filtered
}

pub fn list_sessions(project_path: &str, limit: usize) -> Result<Vec<OpenCodeSession>, String> {
    Ok(filter_sessions(
        list_all_sessions(limit.saturating_mul(4).max(limit))?,
        project_path,
        limit,
    ))
}

pub fn detect_session(
    cli_project_paths: &[&str],
    after: chrono::DateTime<chrono::Utc>,
) -> Result<Option<String>, String> {
    detect_in_sessions(list_all_sessions(500)?, cli_project_paths, after)
}

fn detect_in_sessions(
    mut sessions: Vec<OpenCodeSession>,
    cli_project_paths: &[&str],
    after: chrono::DateTime<chrono::Utc>,
) -> Result<Option<String>, String> {
    let targets = cli_project_paths
        .iter()
        .map(|path| normalize_compare_path(path))
        .collect::<Vec<_>>();
    let after_relaxed = after - chrono::Duration::seconds(1);

    sessions.sort_by_key(|session| std::cmp::Reverse(session.modified_at));
    for session in sessions {
        let modified_at = chrono::DateTime::<Utc>::from_timestamp(session.modified_at as i64, 0)
            .ok_or_else(|| "Invalid OpenCode session timestamp".to_string())?;
        if modified_at < after_relaxed {
            continue;
        }
        if targets.contains(&normalize_compare_path(&session.project_path)) {
            return Ok(Some(session.id));
        }
    }

    Ok(None)
}

#[cfg(windows)]
fn collect_wsl_sessions(
    limit: usize,
    distro: Option<&str>,
) -> Result<Vec<OpenCodeSession>, String> {
    let distro = resolve_wsl_distro(distro)?;
    let wsl_path = which::which("wsl.exe")
        .or_else(|_| which::which("wsl"))
        .map_err(|_| "wsl.exe not found in PATH".to_string())?;

    let script = format!(
        r###"PY_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PY_BIN="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PY_BIN="$(command -v python)"
else
  exit 127
fi
"$PY_BIN" - <<'PY'
import json
import os
import sqlite3
from pathlib import Path

LIMIT = {limit}
DATA_DIR = Path(os.environ.get("OPENCODE_DATA_DIR") or (Path.home() / ".local" / "share" / "opencode"))
DB_PATH = DATA_DIR / "opencode.db"

def should_skip(text: str) -> bool:
    trimmed = text.strip()
    return len(trimmed) < 3 or trimmed == "继续" or trimmed.lower() == "continue"

def truncate(text: str) -> str:
    return text[:80] + ("..." if len(text) > 80 else "")

def millis_to_secs(value):
    try:
        value = int(value or 0)
    except Exception:
        return 0
    if value <= 0:
        return 0
    return value // 1000 if value > 10_000_000_000 else value

def description(conn, session_id, fallback):
    try:
        rows = conn.execute(
            "SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC LIMIT 80",
            (session_id,),
        ).fetchall()
    except sqlite3.Error:
        return fallback or ""
    for (data,) in rows:
        try:
            payload = json.loads(data)
        except Exception:
            continue
        if payload.get("type") != "text":
            continue
        text = (payload.get("text") or "").strip()
        if text and not should_skip(text):
            return truncate(text)
    return fallback or ""

if not DB_PATH.exists():
    raise SystemExit(0)

conn = sqlite3.connect(f"file:{{DB_PATH}}?mode=ro", uri=True)
rows = conn.execute(
    """
    SELECT
        session.id,
        COALESCE(NULLIF(project.worktree, ''), NULLIF(session.directory, ''), '/') AS project_path,
        session.title,
        session.time_updated
    FROM session
    LEFT JOIN project ON project.id = session.project_id
    WHERE session.time_archived IS NULL
    ORDER BY session.time_updated DESC
    LIMIT ?
    """,
    (LIMIT,),
).fetchall()

for session_id, project_path, title, time_updated in rows:
    print(json.dumps({{
        "id": session_id,
        "project_path": project_path,
        "modified_at": millis_to_secs(time_updated),
        "file_path": f"{{DB_PATH}}#session:{{session_id}}",
        "description": description(conn, session_id, title),
    }}, ensure_ascii=False))
PY"###,
        limit = limit,
    );

    let output = no_window_command(&wsl_path)
        .args(["-d", &distro, "--", "bash", "-lc", &script])
        .output()
        .map_err(|error| format!("Failed to run WSL OpenCode session scan: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "WSL OpenCode session scan failed: {}",
            stderr.trim()
        ));
    }

    parse_serialized_sessions(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(windows))]
fn collect_wsl_sessions(
    _limit: usize,
    _distro: Option<&str>,
) -> Result<Vec<OpenCodeSession>, String> {
    Err("WSL OpenCode session extraction is only supported on Windows hosts".to_string())
}

pub fn list_wsl_sessions(
    project_path: &str,
    limit: usize,
    distro: Option<&str>,
) -> Result<Vec<OpenCodeSession>, String> {
    Ok(filter_sessions(
        collect_wsl_sessions(limit.saturating_mul(4).max(limit), distro)?,
        project_path,
        limit,
    ))
}

pub fn list_all_wsl_sessions(
    limit: usize,
    distro: Option<&str>,
) -> Result<Vec<OpenCodeSession>, String> {
    collect_wsl_sessions(limit, distro)
}

pub fn detect_wsl_session(
    cli_project_paths: &[&str],
    after: chrono::DateTime<chrono::Utc>,
    distro: Option<&str>,
) -> Result<Option<String>, String> {
    detect_in_sessions(
        list_all_wsl_sessions(500, distro)?,
        cli_project_paths,
        after,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::NamedTempFile;

    fn create_db() -> NamedTempFile {
        let file = NamedTempFile::new().unwrap();
        let conn = Connection::open(file.path()).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE project (
                id TEXT PRIMARY KEY,
                worktree TEXT NOT NULL
            );
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                directory TEXT NOT NULL,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project (id, worktree) VALUES (?1, ?2)",
            ("proj-1", "/repo/project"),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session (id, project_id, title, directory, time_updated, time_archived)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
            (
                "ses_1",
                "proj-1",
                "Title fallback",
                "/repo/project",
                1_785_000_000_000_i64,
            ),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
            (
                "prt_1",
                "ses_1",
                1_i64,
                r#"{"type":"text","text":"implement opencode resume support"}"#,
            ),
        )
        .unwrap();
        drop(conn);
        file
    }

    #[test]
    fn list_all_sessions_reads_opencode_sqlite() {
        let db = create_db();

        let sessions = list_all_sessions_from_db(db.path(), 10).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "ses_1");
        assert_eq!(sessions[0].project_path, "/repo/project");
        assert_eq!(sessions[0].modified_at, 1_785_000_000);
        assert_eq!(sessions[0].description, "implement opencode resume support");
    }

    #[test]
    fn filter_sessions_matches_normalized_paths() {
        let sessions = vec![OpenCodeSession {
            id: "ses_win".to_string(),
            project_path: "/mnt/d/repo/project".to_string(),
            modified_at: 1000,
            file_path: "db#session:ses_win".to_string(),
            description: String::new(),
        }];

        let filtered = filter_sessions(sessions, "D:\\repo\\project", 10);

        assert_eq!(filtered[0].id, "ses_win");
    }

    #[test]
    fn filter_sessions_matches_wsl_unc_registered_path() {
        // 会话目录是 WSL 内 POSIX，注册路径是 WSL UNC —— 二者必须归一到同一形态才匹配。
        let sessions = vec![OpenCodeSession {
            id: "ses_unc".to_string(),
            project_path: "/mnt/d/04_workspace_rust/cc-book".to_string(),
            modified_at: 1000,
            file_path: "db#session:ses_unc".to_string(),
            description: String::new(),
        }];

        let filtered = filter_sessions(
            sessions,
            "\\\\wsl.localhost\\Ubuntu\\mnt\\d\\04_workspace_rust\\cc-book",
            10,
        );

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "ses_unc");
    }

    #[test]
    fn detect_session_picks_recent_matching_project() {
        let sessions = vec![
            OpenCodeSession {
                id: "old".to_string(),
                project_path: "/repo/project".to_string(),
                modified_at: 900,
                file_path: String::new(),
                description: String::new(),
            },
            OpenCodeSession {
                id: "new".to_string(),
                project_path: "/repo/project".to_string(),
                modified_at: 1000,
                file_path: String::new(),
                description: String::new(),
            },
        ];

        let after = chrono::DateTime::<Utc>::from_timestamp(999, 0).unwrap();
        let got = detect_in_sessions(sessions, &["/repo/project"], after).unwrap();

        assert_eq!(got, Some("new".to_string()));
    }
}
