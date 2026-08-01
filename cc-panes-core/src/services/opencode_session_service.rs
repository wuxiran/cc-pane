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

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use super::codex_session_service::normalize_cross_platform_compare_path;
use crate::utils::{canonical_project_path, project_identity_key};

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

#[derive(Debug, Serialize)]
struct ProjectPathFilter {
    candidates: Vec<String>,
    case_insensitive: bool,
}

/// OpenCode 的数据库可能记录 Windows 盘符或 WSL 内的 `/mnt/<drive>`。比较键直接复用
/// Codex 反查语义，避免两套会话服务对 POSIX 大小写得出不同结论。
fn project_path_filter(path: &str) -> ProjectPathFilter {
    let normalized = normalize_cross_platform_compare_path(path);
    let canonical = canonical_project_path(path);
    let case_insensitive = canonical != project_identity_key(path);
    let canonical_candidate = canonical
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let mut candidates = vec![canonical_candidate];
    // Codex 的 POSIX 键只用于盘符/WSL 到数据库目录的跨形态映射；其 UNC/相对路径兜底会
    // lowercase，不能反过来放松 canonical_project_path 的大小写语义。
    if normalized.starts_with('/') && !normalized.starts_with("//") {
        candidates.push(normalized);
    }
    if case_insensitive {
        candidates
            .iter_mut()
            .for_each(|path| path.make_ascii_lowercase());
    }
    candidates.sort();
    candidates.dedup();
    ProjectPathFilter {
        candidates,
        case_insensitive,
    }
}

fn sqlite_limit(limit: usize) -> i64 {
    // `usize as i64` can wrap to a negative SQLite LIMIT (negative means unlimited).
    i64::try_from(limit).unwrap_or(i64::MAX)
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
    query_sessions_from_db(&default_db_path()?, None, None, limit)
}

#[cfg(test)]
fn list_all_sessions_from_db(path: &Path, limit: usize) -> Result<Vec<OpenCodeSession>, String> {
    query_sessions_from_db(path, None, None, limit)
}

fn list_sessions_from_db(
    path: &Path,
    project_path: &str,
    limit: usize,
) -> Result<Vec<OpenCodeSession>, String> {
    let filter = project_path_filter(project_path);
    query_sessions_from_db(path, Some(&filter), None, limit)
}

fn query_sessions_from_db(
    path: &Path,
    project_filter: Option<&ProjectPathFilter>,
    after_seconds: Option<i64>,
    limit: usize,
) -> Result<Vec<OpenCodeSession>, String> {
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
              AND (
                    ?1 = 0
                    OR (
                        ?2 = 1
                        AND lower(rtrim(replace(
                            COALESCE(NULLIF(project.worktree, ''), NULLIF(session.directory, ''), '/'),
                            char(92), '/'
                        ), '/')) IN (?3, ?4)
                    )
                    OR (
                        ?2 = 0
                        AND rtrim(replace(
                            COALESCE(NULLIF(project.worktree, ''), NULLIF(session.directory, ''), '/'),
                            char(92), '/'
                        ), '/') IN (?3, ?4)
                    )
              )
              AND (
                    ?5 IS NULL
                    OR CASE
                        WHEN session.time_updated > 10000000000
                            THEN session.time_updated / 1000
                        ELSE session.time_updated
                    END >= ?5
              )
            ORDER BY session.time_updated DESC
            LIMIT ?6
            "#,
        )
        .map_err(|error| format!("Failed to prepare OpenCode session query: {}", error))?;

    let (filter_enabled, case_insensitive, candidate_one, candidate_two) = match project_filter {
        Some(filter) => {
            let first = filter.candidates.first().cloned().unwrap_or_default();
            let second = filter
                .candidates
                .get(1)
                .cloned()
                .unwrap_or_else(|| first.clone());
            let case_insensitive = if filter.case_insensitive {
                1_i64
            } else {
                0_i64
            };
            (1_i64, case_insensitive, first, second)
        }
        None => (0_i64, 0_i64, String::new(), String::new()),
    };
    let rows = stmt
        .query_map(
            params![
                filter_enabled,
                case_insensitive,
                candidate_one,
                candidate_two,
                after_seconds,
                sqlite_limit(limit),
            ],
            |row| {
                let id: String = row.get(0)?;
                let project_path: String = row.get(1)?;
                let title: String = row.get(2)?;
                let time_updated: i64 = row.get(3)?;
                Ok((id, project_path, title, time_updated))
            },
        )
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

pub fn list_sessions(project_path: &str, limit: usize) -> Result<Vec<OpenCodeSession>, String> {
    // 项目条件必须先进入 SQL；全局 LIMIT 后再过滤会让活跃项目挤掉目标项目的历史。
    list_sessions_from_db(&default_db_path()?, project_path, limit)
}

pub fn detect_session(
    cli_project_paths: &[&str],
    after: chrono::DateTime<chrono::Utc>,
) -> Result<Option<String>, String> {
    detect_session_from_db(&default_db_path()?, cli_project_paths, after)
}

fn detect_session_from_db(
    path: &Path,
    cli_project_paths: &[&str],
    after: chrono::DateTime<chrono::Utc>,
) -> Result<Option<String>, String> {
    let after_seconds = (after - chrono::Duration::seconds(1)).timestamp();
    let mut newest: Option<OpenCodeSession> = None;
    for project_path in cli_project_paths {
        let filter = project_path_filter(project_path);
        if let Some(session) = query_sessions_from_db(path, Some(&filter), Some(after_seconds), 1)?
            .into_iter()
            .next()
        {
            if newest
                .as_ref()
                .is_none_or(|current| session.modified_at > current.modified_at)
            {
                newest = Some(session);
            }
        }
    }
    Ok(newest.map(|session| session.id))
}

#[cfg(windows)]
fn collect_wsl_sessions(
    limit: usize,
    distro: Option<&str>,
    project_paths: &[&str],
    after_seconds: Option<i64>,
) -> Result<Vec<OpenCodeSession>, String> {
    let distro = resolve_wsl_distro(distro)?;
    let wsl_path = which::which("wsl.exe")
        .or_else(|_| which::which("wsl"))
        .map_err(|_| "wsl.exe not found in PATH".to_string())?;
    let filters = project_paths
        .iter()
        .map(|path| project_path_filter(path))
        .collect::<Vec<_>>();
    let query_json = serde_json::to_string(&serde_json::json!({
        "filters": filters,
        "after_seconds": after_seconds,
        "limit": sqlite_limit(limit),
    }))
    .map_err(|error| format!("Failed to serialize WSL OpenCode query: {}", error))?;
    let query_literal = serde_json::to_string(&query_json)
        .map_err(|error| format!("Failed to quote WSL OpenCode query: {}", error))?;

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

QUERY = json.loads({query_literal})
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

def path_matches(value):
    normalized = (value or "/").replace(chr(92), "/").rstrip("/")
    filters = QUERY["filters"]
    if not filters:
        return 1
    for item in filters:
        candidate = normalized.lower() if item["case_insensitive"] else normalized
        if candidate in item["candidates"]:
            return 1
    return 0

if not DB_PATH.exists():
    raise SystemExit(0)

conn = sqlite3.connect(f"file:{{DB_PATH}}?mode=ro", uri=True)
conn.create_function("cc_path_matches", 1, path_matches)
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
      AND cc_path_matches(
            COALESCE(NULLIF(project.worktree, ''), NULLIF(session.directory, ''), '/')
      ) = 1
      AND (
            ? IS NULL
            OR CASE
                WHEN session.time_updated > 10000000000 THEN session.time_updated / 1000
                ELSE session.time_updated
            END >= ?
      )
    ORDER BY session.time_updated DESC
    LIMIT ?
    """,
    (QUERY["after_seconds"], QUERY["after_seconds"], QUERY["limit"]),
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
        query_literal = query_literal,
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
    _project_paths: &[&str],
    _after_seconds: Option<i64>,
) -> Result<Vec<OpenCodeSession>, String> {
    Err("WSL OpenCode session extraction is only supported on Windows hosts".to_string())
}

pub fn list_wsl_sessions(
    project_path: &str,
    limit: usize,
    distro: Option<&str>,
) -> Result<Vec<OpenCodeSession>, String> {
    // WSL 内也必须在 SQLite 查询阶段筛项目，不能先做全局 LIMIT。
    collect_wsl_sessions(limit, distro, &[project_path], None)
}

pub fn list_all_wsl_sessions(
    limit: usize,
    distro: Option<&str>,
) -> Result<Vec<OpenCodeSession>, String> {
    collect_wsl_sessions(limit, distro, &[], None)
}

pub fn detect_wsl_session(
    cli_project_paths: &[&str],
    after: chrono::DateTime<chrono::Utc>,
    distro: Option<&str>,
) -> Result<Option<String>, String> {
    let after_seconds = (after - chrono::Duration::seconds(1)).timestamp();
    Ok(
        collect_wsl_sessions(1, distro, cli_project_paths, Some(after_seconds))?
            .into_iter()
            .next()
            .map(|session| session.id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
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

    fn set_project_path(db: &NamedTempFile, path: &str) {
        let conn = Connection::open(db.path()).unwrap();
        conn.execute(
            "UPDATE project SET worktree = ?1 WHERE id = 'proj-1'",
            [path],
        )
        .unwrap();
    }

    fn insert_distractor_sessions(db: &NamedTempFile, count: usize) {
        let mut conn = Connection::open(db.path()).unwrap();
        let transaction = conn.transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO project (id, worktree) VALUES (?1, ?2)",
                ("proj-other", "/repo/other"),
            )
            .unwrap();
        for index in 0..count {
            transaction
                .execute(
                    "INSERT INTO session (
                        id, project_id, title, directory, time_updated, time_archived
                     ) VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                    params![
                        format!("other-{index}"),
                        "proj-other",
                        "Other project",
                        "/repo/other",
                        1_785_000_000_001_i64 + index as i64,
                    ],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
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
    fn list_sessions_filters_before_applying_limit() {
        let db = create_db();
        insert_distractor_sessions(&db, 5);

        let sessions = list_sessions_from_db(db.path(), "/repo/project", 1).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "ses_1");
    }

    #[test]
    fn list_sessions_matches_windows_drive_case_insensitively() {
        let db = create_db();
        set_project_path(&db, "/mnt/d/Repo/Project");

        let sessions = list_sessions_from_db(db.path(), "D:\\repo\\project", 10).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "ses_1");
    }

    #[test]
    fn list_sessions_matches_wsl_unc_registered_path() {
        let db = create_db();
        set_project_path(&db, "/mnt/d/04_workspace_rust/cc-book");

        let sessions = list_sessions_from_db(
            db.path(),
            "\\\\wsl.localhost\\Ubuntu\\mnt\\d\\04_workspace_rust\\cc-book",
            10,
        )
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "ses_1");
    }

    #[test]
    fn list_sessions_keeps_posix_paths_case_sensitive() {
        let db = create_db();
        set_project_path(&db, "/home/dev/Repo");

        let exact = list_sessions_from_db(db.path(), "/home/dev/Repo", 10).unwrap();
        let different_case = list_sessions_from_db(db.path(), "/home/dev/repo", 10).unwrap();

        assert_eq!(exact.len(), 1);
        assert!(different_case.is_empty());
    }

    #[test]
    fn detect_session_filters_project_before_limit() {
        let db = create_db();
        insert_distractor_sessions(&db, 501);

        let after = chrono::DateTime::<Utc>::from_timestamp(1_784_999_999, 0).unwrap();
        let got = detect_session_from_db(db.path(), &["/repo/project"], after).unwrap();

        assert_eq!(got, Some("ses_1".to_string()));
    }

    #[test]
    fn sqlite_limit_never_wraps_negative() {
        assert_eq!(
            sqlite_limit(usize::MAX),
            i64::try_from(usize::MAX).unwrap_or(i64::MAX)
        );
        assert!(sqlite_limit(usize::MAX) >= 0);
    }
}
