//! Codex Session Service — 从 ~/.codex/sessions 读取 Codex CLI 历史会话
//!
//! 提供按项目或全局列举 Codex 会话的能力，并支持从会话文件中提取基本元数据。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::SystemTime;

#[cfg(windows)]
use crate::utils::no_window_command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodexSession {
    pub id: String,
    pub project_path: String,
    pub modified_at: u64,
    pub file_path: String,
    pub description: String,
}

fn normalize_compare_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn collect_user_text(content: &Value) -> Option<String> {
    let items = content.as_array()?;
    let mut merged = Vec::new();
    for item in items {
        if item.get("type").and_then(|value| value.as_str()) != Some("input_text") {
            continue;
        }
        let text = item
            .get("text")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        merged.push(text.to_string());
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged.join("\n"))
    }
}

fn should_skip_description(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.len() < 3
        || trimmed == "继续"
        || trimmed.eq_ignore_ascii_case("continue")
        || trimmed.starts_with("# AGENTS.md instructions")
        || trimmed.contains("<environment_context>")
}

fn truncate_description(text: &str) -> String {
    let desc: String = text.chars().take(80).collect();
    if desc.len() < text.len() {
        format!("{}...", desc)
    } else {
        desc
    }
}

fn extract_session_description(file_path: &Path) -> String {
    let file = match File::open(file_path) {
        Ok(file) => file,
        Err(_) => return String::new(),
    };
    let reader = BufReader::new(file);

    for line in reader.lines().take(200) {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        let json: Value = match serde_json::from_str(&line) {
            Ok(json) => json,
            Err(_) => continue,
        };
        if json.get("type").and_then(|value| value.as_str()) != Some("response_item") {
            continue;
        }
        let payload = match json.get("payload") {
            Some(payload) => payload,
            None => continue,
        };
        if payload.get("type").and_then(|value| value.as_str()) != Some("message") {
            continue;
        }
        if payload.get("role").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }
        let text = match payload.get("content").and_then(collect_user_text) {
            Some(text) => text,
            None => continue,
        };
        if should_skip_description(&text) {
            continue;
        }
        return truncate_description(&text);
    }

    String::new()
}

fn parse_session_meta(file_path: &Path) -> Option<(String, String)> {
    let file = File::open(file_path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines().take(20) {
        let line = line.ok()?;
        let json: Value = serde_json::from_str(&line).ok()?;
        if json.get("type").and_then(|value| value.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = json.get("payload")?;
        let id = payload.get("id")?.as_str()?.to_string();
        let cwd = payload.get("cwd")?.as_str()?.to_string();
        return Some((id, cwd));
    }

    None
}

fn parse_session_file(file_path: &Path) -> Option<CodexSession> {
    let (id, cwd) = parse_session_meta(file_path)?;
    let metadata = fs::metadata(file_path).ok()?;
    let modified = metadata.modified().ok()?;
    let modified_at = modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_secs();

    Some(CodexSession {
        id,
        project_path: cwd,
        modified_at,
        file_path: file_path.to_string_lossy().to_string(),
        description: extract_session_description(file_path),
    })
}

fn collect_session_files(root: &Path, sessions: &mut Vec<CodexSession>) -> Result<(), String> {
    let entries = fs::read_dir(root).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_files(&path, sessions)?;
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(session) = parse_session_file(&path) {
            sessions.push(session);
        }
    }
    Ok(())
}

fn filter_sessions(
    sessions: Vec<CodexSession>,
    project_path: &str,
    limit: usize,
) -> Vec<CodexSession> {
    let target = normalize_compare_path(project_path);
    let mut filtered = sessions
        .into_iter()
        .filter(|session| normalize_compare_path(&session.project_path) == target)
        .collect::<Vec<_>>();
    filtered.truncate(limit);
    filtered
}

pub fn list_sessions(project_path: &str, limit: usize) -> Result<Vec<CodexSession>, String> {
    Ok(filter_sessions(
        list_all_sessions(limit.saturating_mul(4).max(limit))?,
        project_path,
        limit,
    ))
}

pub fn list_all_sessions(limit: usize) -> Result<Vec<CodexSession>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to get user home directory".to_string())?;
    let sessions_root = home.join(".codex").join("sessions");
    if !sessions_root.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    collect_session_files(&sessions_root, &mut sessions)?;
    sessions.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    sessions.truncate(limit);
    Ok(sessions)
}

#[cfg(windows)]
fn parse_serialized_sessions(stdout: &str) -> Result<Vec<CodexSession>, String> {
    let mut sessions = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let session: CodexSession = serde_json::from_str(trimmed)
            .map_err(|error| format!("Failed to parse WSL Codex session payload: {}", error))?;
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

#[cfg(windows)]
fn collect_wsl_sessions(limit: usize, distro: Option<&str>) -> Result<Vec<CodexSession>, String> {
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
from pathlib import Path

LIMIT = {limit}
ROOT = Path.home() / ".codex" / "sessions"

def should_skip(text: str) -> bool:
    trimmed = text.strip()
    return (
        len(trimmed) < 3
        or trimmed == "继续"
        or trimmed.lower() == "continue"
        or trimmed.startswith("# AGENTS.md instructions")
        or "<environment_context>" in trimmed
    )

def truncate(text: str) -> str:
    return text[:80] + ("..." if len(text) > 80 else "")

def extract_desc(path: Path) -> str:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for idx, line in enumerate(handle):
                if idx >= 200:
                    break
                try:
                    payload = json.loads(line)
                except Exception:
                    continue
                if payload.get("type") != "response_item":
                    continue
                body = payload.get("payload") or {{}}
                if body.get("type") != "message" or body.get("role") != "user":
                    continue
                items = body.get("content") or []
                texts = []
                for item in items:
                    if item.get("type") != "input_text":
                        continue
                    text = (item.get("text") or "").strip()
                    if not text or should_skip(text):
                        continue
                    texts.append(text)
                if texts:
                    return truncate("\\n".join(texts))
    except OSError:
        return ""
    return ""

def parse_meta(path: Path):
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for idx, line in enumerate(handle):
                if idx >= 20:
                    break
                try:
                    payload = json.loads(line)
                except Exception:
                    continue
                if payload.get("type") != "session_meta":
                    continue
                meta = payload.get("payload") or {{}}
                session_id = meta.get("id")
                cwd = meta.get("cwd")
                if session_id and cwd:
                    return session_id, cwd
    except OSError:
        return None, None
    return None, None

sessions = []
if ROOT.exists():
    for path in ROOT.rglob("*.jsonl"):
        session_id, cwd = parse_meta(path)
        if not session_id or not cwd:
            continue
        try:
            modified_at = int(path.stat().st_mtime)
        except OSError:
            continue
        sessions.append({{
            "id": session_id,
            "project_path": cwd,
            "modified_at": modified_at,
            "file_path": str(path),
            "description": extract_desc(path),
        }})

sessions.sort(key=lambda item: item["modified_at"], reverse=True)
for session in sessions[:LIMIT]:
    print(json.dumps(session, ensure_ascii=False))
PY"###,
        limit = limit,
    );

    let output = no_window_command(&wsl_path)
        .args(["-d", &distro, "--", "bash", "-lc", &script])
        .output()
        .map_err(|error| format!("Failed to run WSL Codex session scan: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("WSL Codex session scan failed: {}", stderr.trim()));
    }

    parse_serialized_sessions(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(windows))]
fn collect_wsl_sessions(_limit: usize, _distro: Option<&str>) -> Result<Vec<CodexSession>, String> {
    Err("WSL Codex session extraction is only supported on Windows hosts".to_string())
}

pub fn list_wsl_sessions(
    project_path: &str,
    limit: usize,
    distro: Option<&str>,
) -> Result<Vec<CodexSession>, String> {
    Ok(filter_sessions(
        collect_wsl_sessions(limit.saturating_mul(4).max(limit), distro)?,
        project_path,
        limit,
    ))
}

pub fn list_all_wsl_sessions(
    limit: usize,
    distro: Option<&str>,
) -> Result<Vec<CodexSession>, String> {
    collect_wsl_sessions(limit, distro)
}

pub fn detect_session(
    cli_project_paths: &[&str],
    after: chrono::DateTime<chrono::Utc>,
) -> Result<Option<String>, String> {
    let max_scan = 500usize;
    let sessions = list_all_sessions(max_scan)?;
    detect_in_sessions(sessions, cli_project_paths, after)
}

fn detect_in_sessions(
    sessions: Vec<CodexSession>,
    cli_project_paths: &[&str],
    after: chrono::DateTime<chrono::Utc>,
) -> Result<Option<String>, String> {
    let targets = cli_project_paths
        .iter()
        .map(|path| normalize_compare_path(path))
        .collect::<Vec<_>>();

    for session in sessions {
        let modified_at =
            chrono::DateTime::<chrono::Utc>::from_timestamp(session.modified_at as i64, 0)
                .ok_or_else(|| "Invalid Codex session timestamp".to_string())?;
        if modified_at < after {
            continue;
        }
        let session_path = normalize_compare_path(&session.project_path);
        if targets.iter().any(|target| *target == session_path) {
            return Ok(Some(session.id));
        }
    }

    Ok(None)
}

pub fn detect_wsl_session(
    cli_project_paths: &[&str],
    after: chrono::DateTime<chrono::Utc>,
    distro: Option<&str>,
) -> Result<Option<String>, String> {
    let max_scan = 500usize;
    let sessions = list_all_wsl_sessions(max_scan, distro)?;
    detect_in_sessions(sessions, cli_project_paths, after)
}

#[cfg(test)]
mod tests {
    use super::{extract_session_description, parse_session_file};
    use std::fs;
    use tempfile::NamedTempFile;

    fn write_session_file(lines: &[&str]) -> std::path::PathBuf {
        let temp_file = NamedTempFile::new().expect("temp file");
        let (_file, path) = temp_file.keep().expect("persist temp file");
        fs::write(&path, lines.join("\n")).expect("write session file");
        path
    }

    #[test]
    fn extract_session_description_skips_context_payloads() {
        let path = write_session_file(&[
            r#"{"type":"session_meta","payload":{"id":"session-1","cwd":"/tmp/project"}}"#,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/project"}]}}"##,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the failing codex resume flow"}]}}"#,
        ]);

        let description = extract_session_description(&path);

        assert_eq!(description, "fix the failing codex resume flow");
    }

    #[test]
    fn parse_session_file_reads_meta_fields() {
        let path = write_session_file(&[
            r#"{"type":"session_meta","payload":{"id":"session-42","cwd":"/tmp/project"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}}"#,
        ]);

        let session = parse_session_file(&path).expect("session metadata");

        assert_eq!(session.id, "session-42");
        assert_eq!(session.project_path, "/tmp/project");
        assert_eq!(session.file_path, path.to_string_lossy());
    }
}
