//! Codex Session Service — 从 ~/.codex/sessions 读取 Codex CLI 历史会话
//!
//! 提供按项目或全局列举 Codex 会话的能力，并支持从会话文件中提取基本元数据。

use crate::models::UsageEntry;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tracing::warn;

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

/// 跨平台归一化 backfill 反查的路径比较键：把 Windows 盘符 / WSL UNC / `\\?\` 扩展前缀
/// 统一到 WSL 视角的 POSIX `/mnt/<drive>/...`，让 Windows/UNC 形态的候选能匹配 rollout
/// 里 POSIX 形态的 `session_meta.cwd`。非 WSL 网络共享、盘符相对路径不强转 `/mnt`，仅做
/// 保守归一（避免误判）。**无 `#[cfg(windows)]`**：cc-panes-core 跨平台、需在 Linux 跑单测。
pub(crate) fn normalize_cross_platform_compare_path(path: &str) -> String {
    let stripped = strip_extended_length_prefix(path);
    let slashed = stripped.replace('\\', "/");

    // WSL UNC（//wsl.localhost/<distro>/… | //wsl$/<distro>/… | //wsl/<distro>/…）
    // → 取 distro 内的 POSIX 绝对路径，POSIX 大小写敏感不 lowercase。
    if let Some(rest) = strip_wsl_unc_prefix(&slashed) {
        return rest.trim_end_matches('/').to_string();
    }

    // 盘符绝对路径（D:/x，`:` 后紧跟分隔符）→ /mnt/d/x（盘符路径统一 lowercase）。
    if let Some(mnt) = drive_to_mnt_path(&slashed) {
        return mnt.trim_end_matches('/').to_lowercase();
    }

    // 纯 POSIX 绝对路径（单斜杠开头、非 UNC 双斜杠）：去尾斜杠，保持大小写（Linux 敏感）。
    if slashed.starts_with('/') && !slashed.starts_with("//") {
        return slashed.trim_end_matches('/').to_string();
    }

    // 兜底（纯 UNC //server/share、C:relative 相对路径、其它）：lowercase + 去尾斜杠
    // （= 旧 normalize_compare_path 行为）。
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

/// Windows 盘符绝对路径 → `/mnt/<drive>/…`。要求 `<letter>:` 后紧跟分隔符，
/// 否则（如 `C:relative`）返回 None，不当作绝对盘符。入参须已把 `\` 转 `/`。
fn drive_to_mnt_path(slashed: &str) -> Option<String> {
    let bytes = slashed.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        let drive = bytes[0].to_ascii_lowercase() as char;
        return Some(format!("/mnt/{}{}", drive, &slashed[2..]));
    }
    None
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

pub fn read_session_meta(file_path: &Path) -> Option<(String, String)> {
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
    let (id, cwd) = read_session_meta(file_path)?;
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
    let sessions_root = codex_sessions_root()?;
    if !sessions_root.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    collect_session_files(&sessions_root, &mut sessions)?;
    sessions.sort_by_key(|session| std::cmp::Reverse(session.modified_at));
    sessions.truncate(limit);
    Ok(sessions)
}

fn codex_sessions_root() -> Result<PathBuf, String> {
    if let Some(codex_home) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(codex_home).join("sessions"));
    }
    let home = dirs::home_dir().ok_or_else(|| "Failed to get user home directory".to_string())?;
    Ok(home.join(".codex").join("sessions"))
}

pub fn read_session_usage(
    jsonl_path: &Path,
    from_byte_offset: u64,
) -> Result<(Vec<UsageEntry>, u64), String> {
    let mut file = File::open(jsonl_path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = from_byte_offset.min(len);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(file);
    let mut offset = start;
    let mut entries = Vec::new();

    loop {
        let mut buf = Vec::new();
        let read = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        if !buf.ends_with(b"\n") {
            break;
        }
        let line_offset = offset;
        offset += read as u64;

        let line = String::from_utf8_lossy(&buf);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match serde_json::from_str::<Value>(trimmed) {
            Ok(json) => {
                if let Some(entry) = extract_codex_usage(&json).filter(|entry| !entry.is_empty()) {
                    entries.push(entry);
                }
            }
            Err(error) => {
                warn!(
                    path = %jsonl_path.display(),
                    offset = line_offset,
                    err = %error,
                    "Skipping invalid Codex jsonl line"
                );
            }
        }
    }

    Ok((entries, offset))
}

fn extract_codex_usage(json: &Value) -> Option<UsageEntry> {
    if json.get("type").and_then(|value| value.as_str()) == Some("event_msg")
        && json
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(|value| value.as_str())
            == Some("token_count")
    {
        let usage = json.get("payload")?.get("info")?.get("last_token_usage")?;
        return Some(UsageEntry {
            date: usage_date(json),
            token_input: number_field(usage, &["input_tokens", "prompt_tokens"]),
            token_output: number_field(usage, &["output_tokens", "completion_tokens"]),
            // OpenAI Responses API: cached tokens 在 input_tokens_details.cached_tokens 嵌套
            // 顶层字段是历史/其他变体的兼容
            token_cache_read: cache_read_tokens(usage),
            token_cache_creation: number_field(usage, &["cache_creation_input_tokens"]),
        });
    }

    if json.get("type").and_then(|value| value.as_str()) != Some("response_item") {
        return None;
    }

    let payload = json.get("payload")?;
    let usage = payload
        .get("usage")
        .or_else(|| {
            payload
                .get("response")
                .and_then(|response| response.get("usage"))
        })
        .or_else(|| payload.get("payload").and_then(|inner| inner.get("usage")))?;

    Some(UsageEntry {
        date: usage_date(json),
        token_input: number_field(usage, &["input_tokens", "prompt_tokens"]),
        token_output: number_field(usage, &["output_tokens", "completion_tokens"]),
        token_cache_read: cache_read_tokens(usage),
        token_cache_creation: number_field(usage, &["cache_creation_input_tokens"]),
    })
}

fn usage_date(json: &Value) -> String {
    json.get("timestamp")
        .and_then(|value| value.as_str())
        .or_else(|| {
            json.get("payload")
                .and_then(|payload| payload.get("timestamp"))
                .and_then(|value| value.as_str())
        })
        .and_then(parse_local_date)
        .unwrap_or_else(|| Local::now().date_naive().format("%Y-%m-%d").to_string())
}

fn parse_local_date(timestamp: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(timestamp).ok().map(|dt| {
        dt.with_timezone(&Local)
            .date_naive()
            .format("%Y-%m-%d")
            .to_string()
    })
}

fn number_field(value: &Value, names: &[&str]) -> u64 {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(|field| field.as_u64()))
        .unwrap_or(0)
}

fn cache_read_tokens(usage: &Value) -> u64 {
    number_field(usage, &["cache_read_input_tokens", "cached_input_tokens"])
        .max(
            usage
                .get("input_tokens_details")
                .and_then(|details| details.get("cached_tokens"))
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
        )
        .max(
            usage
                .get("prompt_tokens_details")
                .and_then(|details| details.get("cached_tokens"))
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
        )
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
"\$PY_BIN" - <<'PY'
import json
import os
from pathlib import Path

LIMIT = {limit}
ROOT = (Path(os.environ["CODEX_HOME"]) if os.environ.get("CODEX_HOME") else Path.home() / ".codex") / "sessions"

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
        .map(|path| normalize_cross_platform_compare_path(path))
        .collect::<Vec<_>>();

    // mtime 被截成整秒（CodexSession.modified_at = as_secs），而 after 带亚秒；
    // 同秒生成的 rollout 会出现 modified_at < after。放宽 1s 容差以免误跳。
    // after 取 spawn 时刻，旧会话 mtime 远早于它，1s 容差不会误纳旧会话。
    let after_relaxed = after - chrono::Duration::seconds(1);

    // 按 mtime 倒序，确保同 cwd 多个候选时取最新（并发/重启场景）。
    let mut sessions = sessions;
    sessions.sort_by_key(|session| std::cmp::Reverse(session.modified_at));

    for session in sessions {
        let modified_at =
            chrono::DateTime::<chrono::Utc>::from_timestamp(session.modified_at as i64, 0)
                .ok_or_else(|| "Invalid Codex session timestamp".to_string())?;
        if modified_at < after_relaxed {
            continue;
        }
        let session_path = normalize_cross_platform_compare_path(&session.project_path);
        if targets.contains(&session_path) {
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
    use super::{
        detect_in_sessions, extract_session_description, normalize_cross_platform_compare_path,
        parse_session_file, CodexSession,
    };
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

    fn mk_session(id: &str, cwd: &str, modified_at: u64) -> CodexSession {
        CodexSession {
            id: id.to_string(),
            project_path: cwd.to_string(),
            modified_at,
            file_path: format!("/fake/{id}.jsonl"),
            description: String::new(),
        }
    }

    // after 对应的整秒时间戳：用一个固定基准便于构造 mtime。
    fn after_at(secs: u64) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::<chrono::Utc>::from_timestamp(secs as i64, 0).unwrap()
    }

    #[test]
    fn detect_matches_cwd_within_window() {
        let sessions = vec![
            mk_session("other", "/tmp/elsewhere", 1000),
            mk_session("hit", "/tmp/project", 1000),
        ];
        let got = detect_in_sessions(sessions, &["/tmp/project"], after_at(1000)).unwrap();
        assert_eq!(got, Some("hit".to_string()));
    }

    #[test]
    fn detect_skips_rollout_before_after_minus_epsilon() {
        // mtime=997, after=1000 → 比 after-1s(=999) 还早，跳过。
        let sessions = vec![mk_session("old", "/tmp/project", 997)];
        let got = detect_in_sessions(sessions, &["/tmp/project"], after_at(1000)).unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn detect_epsilon_tolerates_same_second_truncation() {
        // rollout 与 spawn 同秒：mtime 被截成 1000，after 实际带亚秒(用 1000 + 1ms 模拟)。
        // 没有 ε 时 1000 < 1000.001 会误跳；ε=1s 后 after_relaxed=999.001，命中。
        let after = chrono::DateTime::<chrono::Utc>::from_timestamp(1000, 1_000_000).unwrap();
        let sessions = vec![mk_session("samesec", "/tmp/project", 1000)];
        let got = detect_in_sessions(sessions, &["/tmp/project"], after).unwrap();
        assert_eq!(got, Some("samesec".to_string()));
    }

    #[test]
    fn detect_picks_latest_when_multiple_same_cwd() {
        // 并发同 cwd：乱序给入，应取 mtime 最新的。
        let sessions = vec![
            mk_session("older", "/tmp/project", 1000),
            mk_session("newest", "/tmp/project", 1005),
            mk_session("mid", "/tmp/project", 1002),
        ];
        let got = detect_in_sessions(sessions, &["/tmp/project"], after_at(1000)).unwrap();
        assert_eq!(got, Some("newest".to_string()));
    }

    #[test]
    fn detect_normalizes_windows_path_case_and_backslash() {
        // candidate 用 Windows 反斜杠+大写，rollout cwd 用小写正斜杠，应命中。
        let sessions = vec![mk_session("win", "d:/proj/app", 1000)];
        let got = detect_in_sessions(sessions, &["D:\\Proj\\App"], after_at(1000)).unwrap();
        assert_eq!(got, Some("win".to_string()));
    }

    #[test]
    fn normalize_cross_platform_drive_to_mnt() {
        assert_eq!(
            normalize_cross_platform_compare_path("I:\\Proj"),
            "/mnt/i/proj"
        );
        assert_eq!(
            normalize_cross_platform_compare_path("D:/Code/App"),
            "/mnt/d/code/app"
        );
    }

    #[test]
    fn normalize_cross_platform_wsl_unc_variants() {
        assert_eq!(
            normalize_cross_platform_compare_path(r"\\wsl.localhost\Ubuntu\mnt\d\cc-book"),
            "/mnt/d/cc-book"
        );
        assert_eq!(
            normalize_cross_platform_compare_path(r"\\wsl$\Ubuntu\mnt\i\x"),
            "/mnt/i/x"
        );
        // 兼容 \\wsl\<distro> 历史写法。
        assert_eq!(
            normalize_cross_platform_compare_path(r"\\wsl\Ubuntu\mnt\d\x"),
            "/mnt/d/x"
        );
    }

    #[test]
    fn normalize_cross_platform_extended_length_prefixes() {
        // \\?\D:\x 与 \\?\UNC\wsl.localhost\... 扩展前缀须先剥离再归一。
        assert_eq!(
            normalize_cross_platform_compare_path(r"\\?\D:\x"),
            "/mnt/d/x"
        );
        assert_eq!(
            normalize_cross_platform_compare_path(r"\\?\UNC\wsl.localhost\Ubuntu\mnt\d\x"),
            "/mnt/d/x"
        );
    }

    #[test]
    fn normalize_cross_platform_posix_passthrough() {
        assert_eq!(
            normalize_cross_platform_compare_path("/mnt/i/x"),
            "/mnt/i/x"
        );
        // POSIX 大小写敏感，不 lowercase；去尾斜杠。
        assert_eq!(
            normalize_cross_platform_compare_path("/home/dev/Repo/"),
            "/home/dev/Repo"
        );
    }

    #[test]
    fn normalize_cross_platform_non_wsl_unc_not_mounted() {
        // 纯网络共享不转 /mnt，仅保守归一（lowercase + 去尾斜杠）。
        assert_eq!(
            normalize_cross_platform_compare_path(r"\\server\share\X"),
            "//server/share/x"
        );
    }

    #[test]
    fn normalize_cross_platform_drive_relative_not_absolute() {
        // C:relative（: 后非分隔符）不当绝对盘符，仅兜底归一。
        assert_eq!(
            normalize_cross_platform_compare_path("C:relative"),
            "c:relative"
        );
    }

    #[test]
    fn detect_matches_wsl_posix_cwd_against_windows_candidates() {
        // rollout cwd 是 POSIX；候选给 Windows 盘符 / WSL UNC / POSIX 三种都应命中。
        for cand in [
            "I:\\proj",
            r"\\wsl.localhost\Ubuntu\mnt\i\proj",
            "/mnt/i/proj",
        ] {
            let sessions = vec![mk_session("wslhit", "/mnt/i/proj", 1000)];
            let got = detect_in_sessions(sessions, &[cand], after_at(1000)).unwrap();
            assert_eq!(
                got,
                Some("wslhit".to_string()),
                "candidate {cand} should match POSIX rollout cwd"
            );
        }
    }
}
