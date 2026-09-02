use chrono::Local;
use serde::Deserialize;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use crate::common::http::{post_json, ApiEndpoint};

/// Hook input from Claude Code (subset of fields we care about).
#[derive(Debug, Deserialize)]
struct HookInput {
    session_id: Option<String>,
    hook_event_name: Option<String>,
    tool_name: Option<String>,
    tool_input: Option<ToolInput>,
}

#[derive(Debug, Deserialize)]
struct ToolInput {
    file_path: Option<String>,
}

/// PostToolUse hook entry point.
/// Reads hook JSON from stdin and archives plan files to the workspace plans dir
/// (`$CC_PANES_PLANS_DIR`), falling back to `<project>/.ccpanes/.cache/plans/`.
///
/// Archived file name format: `{session_prefix}_{timestamp}_{original_name}`
/// Example: `a1b2c3d4_20260215_143052_structured-kindling-canyon.md`
pub fn run() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    run_with_stdin(&input);
}

/// 已读到 stdin 原文的版本（供 events::dispatch 在上报后调用）。
pub fn run_with_stdin(input: &str) {
    let hook: HookInput = match serde_json::from_str(input) {
        Ok(h) => h,
        Err(_) => return,
    };

    // Verify this is the event we care about
    let event = hook.hook_event_name.as_deref().unwrap_or_default();
    let tool = hook.tool_name.as_deref().unwrap_or_default();
    if event != "PostToolUse" || tool != "Write" {
        return;
    }

    // Extract session_id before partial move of hook
    let session_id = hook.session_id.unwrap_or_default();

    let file_path = match hook.tool_input.and_then(|t| t.file_path) {
        Some(p) => p,
        None => return,
    };

    // Check if the file is in ~/.claude/plans/
    let plans_dir = match get_claude_plans_dir() {
        Some(d) => d,
        None => return,
    };

    let file_path_buf = PathBuf::from(&file_path);
    // Normalize for comparison
    let canonical_file = file_path_buf
        .canonicalize()
        .unwrap_or(file_path_buf.clone());
    let canonical_plans = plans_dir.canonicalize().unwrap_or(plans_dir.clone());

    if !canonical_file.starts_with(&canonical_plans) {
        return;
    }

    // 分级归档（docs/98 第三批）：工作空间层优先——CC-Panes 启动时下发
    // `CC_PANES_PLANS_DIR`（`~/.cc-panes/workspaces/<name>/plans`，跨仓共享）；
    // 不在任何工作空间里时落项目的机器本地缓存 `.ccpanes/.cache/plans`（被 `.ccpanes/.gitignore`
    // 忽略，不会进仓库）。按候选目录顺序尝试 create_dir_all；只有全部失败才放弃。
    let workspace_path = std::env::var("CC_PANES_WORKSPACE_PATH")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let workspace_plans_dir = std::env::var("CC_PANES_PLANS_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let project_path_env = std::env::var("CLAUDE_PROJECT_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var("CC_PANES_PROJECT_PATH")
                .ok()
                .filter(|s| !s.trim().is_empty())
        });
    let candidates: Vec<PathBuf> =
        archive_dir_candidates(workspace_plans_dir.as_deref(), project_path_env.as_deref());
    if candidates.is_empty() {
        return; // 两个 env 都没有，弃权
    }
    let mut create_errors: Vec<String> = Vec::new();
    let target_dir = match candidates.iter().find(|d| match fs::create_dir_all(d) {
        Ok(_) => true,
        Err(e) => {
            create_errors.push(format!("{}: {}", d.display(), e));
            false
        }
    }) {
        Some(d) => d.clone(),
        None => {
            eprintln!(
                "[ccpanes] Failed to create plans directory in any candidate: {}",
                create_errors.join(" | ")
            );
            return;
        }
    };

    // Get original file name
    let file_name = match Path::new(&file_path).file_name() {
        Some(n) => n,
        None => return,
    };
    let original_name = file_name.to_string_lossy();

    // Get session ID prefix (first 8 chars)
    let session_prefix = if session_id.len() >= 8 {
        &session_id[..8]
    } else {
        &session_id
    };

    // Check for existing archive with same session + same original name (dedup)
    let target_path = find_existing_archive(&target_dir, session_prefix, &original_name)
        .unwrap_or_else(|| {
            let now = Local::now();
            let timestamp = now.format("%Y%m%d_%H%M%S");
            let archived_name = if session_prefix.is_empty() {
                format!("{timestamp}_{original_name}")
            } else {
                format!("{session_prefix}_{timestamp}_{original_name}")
            };
            target_dir.join(archived_name)
        });

    match fs::copy(&file_path, &target_path) {
        Ok(_) => {
            eprintln!(
                "[ccpanes] Plan archived: {} -> {}",
                file_path,
                target_path.display()
            );

            // Plan-as-memory：解析头部 <!-- ccpanes-plan ... --> 标签并 POST。
            // 任何失败都静默：归档主路径已经成功，不影响用户。
            // 用 read_plan_head_bounded 防大文件（单行 1MB 等）撕开标签解析路径。
            if let Some(head) = read_plan_head_bounded(&file_path) {
                if let Some(tag) = extract_plan_tag(&head) {
                    let _ = post_plan_tag(
                        &session_id,
                        &file_path,
                        &target_path,
                        workspace_path.as_deref(),
                        project_path_env.as_deref(),
                        &tag,
                    );
                }
            }
        }
        Err(e) => {
            eprintln!("[ccpanes] Failed to archive plan: {}", e);
        }
    }
}

/// Find an existing archive file with the same session prefix and original name.
/// Returns the path if found, so we overwrite instead of creating duplicates.
fn find_existing_archive(
    target_dir: &Path,
    session_prefix: &str,
    original_name: &str,
) -> Option<PathBuf> {
    if session_prefix.is_empty() {
        return None;
    }
    let suffix = format!("_{original_name}");
    let entries = fs::read_dir(target_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with(session_prefix) && name_str.ends_with(&suffix) {
            return Some(entry.path());
        }
    }
    None
}

fn get_claude_plans_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let plans_dir = home.join(".claude").join("plans");
    if plans_dir.is_dir() {
        Some(plans_dir)
    } else {
        // Return the path even if it doesn't exist yet;
        // the file comparison will handle it
        Some(plans_dir)
    }
}

// ============ Plan-as-memory: tag extraction + POST ============

/// Plan 头部 HTML 注释标签的 5 个语义字段（全可空，缺失 → None / 空 Vec）。
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanTag {
    #[serde(skip_serializing_if = "Option::is_none")]
    intent: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    scope: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    risk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    followups: Option<String>,
}

/// 字段限长（与后端 plan 表对齐）。
const INTENT_MAX_CHARS: usize = 200;
const FOLLOWUPS_MAX_CHARS: usize = 300;
const TAG_MAX_ITEMS: usize = 8;
const TAG_ITEM_MAX_CHARS: usize = 40;
const SCOPE_MAX_ITEMS: usize = 8;
const SCOPE_ITEM_MAX_CHARS: usize = 80;
/// 防大文件全文加载：只扫描前 N 行。
const TAG_SCAN_MAX_LINES: usize = 80;
/// 防超长单行：读取头部时的总字节上限。
const TAG_SCAN_MAX_BYTES: usize = 64 * 1024;

/// Only absolute paths for the current OS are usable as archive roots.
fn absolute_dir(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    #[cfg(unix)]
    {
        // WSL 中传入的 Windows 路径（如 C:\repo）在 Unix 下会被当作相对路径，
        // create_dir_all 会在当前目录造出假成功目录。只接受绝对 Unix 路径。
        if !trimmed.starts_with('/') {
            return None;
        }
    }
    #[cfg(windows)]
    {
        if !Path::new(trimmed).is_absolute() {
            return None;
        }
    }
    Some(PathBuf::from(trimmed))
}

/// Ordered archive roots: workspace plans dir (verbatim), then the project's
/// machine-local cache `<project>/.ccpanes/.cache/plans`.
fn archive_dir_candidates(
    workspace_plans_dir: Option<&str>,
    project_path: Option<&str>,
) -> Vec<PathBuf> {
    let mut out = Vec::with_capacity(2);
    if let Some(dir) = workspace_plans_dir.and_then(absolute_dir) {
        out.push(dir);
    }
    if let Some(project) = project_path.and_then(absolute_dir) {
        out.push(project.join(".ccpanes").join(".cache").join("plans"));
    }
    out
}

/// 用固定字节块读取 plan 文件头部，**双上限**：行数 + 总字节。
/// 任意一个上限达到就停。若超过总字节上限或头部不是有效 UTF-8，则返回 None。
///
/// 目的：避免恶意 plan 写 1MB 单行触发 `read_to_string` 把整个文件载入内存
/// 再喂进 regex / YAML 解析路径。
fn read_plan_head_bounded(path: &str) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut head = Vec::with_capacity(TAG_SCAN_MAX_BYTES.min(8192));
    let mut lines = 0usize;
    let mut buf = [0u8; 4096];

    while lines < TAG_SCAN_MAX_LINES {
        let remaining = TAG_SCAN_MAX_BYTES + 1 - head.len();
        let read_len = remaining.min(buf.len());
        let n = f.read(&mut buf[..read_len]).ok()?;
        if n == 0 {
            break;
        }

        for &byte in &buf[..n] {
            head.push(byte);
            if head.len() > TAG_SCAN_MAX_BYTES {
                return None;
            }
            if byte == b'\n' {
                lines += 1;
                if lines >= TAG_SCAN_MAX_LINES {
                    break;
                }
            }
        }
    }

    String::from_utf8(head).ok()
}

/// 从 plan 文件内容中提取 `<!-- ccpanes-plan ... -->` 标签。
///
/// 容错策略：
/// 1. 整段标签缺失 → None
/// 2. YAML 解析失败 → 退化为逐行 `key: value` 简易解析，只取认识的 5 个 key
/// 3. 字段类型不对 / 单字段缺失 → 该字段保持 None / 空 Vec
/// 4. 字段超长 → 截断
fn extract_plan_tag(content: &str) -> Option<PlanTag> {
    // 截前 N 行作为搜索范围
    let head: String = content
        .lines()
        .take(TAG_SCAN_MAX_LINES)
        .collect::<Vec<_>>()
        .join("\n");

    let re = regex::Regex::new(r"(?ms)^\s*<!--\s*ccpanes-plan\s*\n(.*?)\n\s*-->").ok()?;
    let caps = re.captures(&head)?;
    let body = caps.get(1)?.as_str();

    // 1) 尝试 YAML 解析
    let tag = match serde_yaml::from_str::<PlanTag>(body) {
        Ok(t) => t,
        Err(_) => parse_tag_lines_fallback(body),
    };
    Some(clamp_tag(tag))
}

/// 退化解析：逐行 `key: value` / `key: [a, b]`，只识别我们认识的 5 个 key。
fn parse_tag_lines_fallback(body: &str) -> PlanTag {
    let mut tag = PlanTag::default();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (key, value) = match trimmed.split_once(':') {
            Some(p) => p,
            None => continue,
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        match key.as_str() {
            "intent" => tag.intent = Some(strip_quotes(value).to_string()),
            "risk" => tag.risk = Some(strip_quotes(value).to_string()),
            "followups" => tag.followups = Some(strip_quotes(value).to_string()),
            "tags" => tag.tags = parse_inline_array(value),
            "scope" => tag.scope = parse_inline_array(value),
            _ => {}
        }
    }
    tag
}

fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

fn parse_inline_array(value: &str) -> Vec<String> {
    let v = value.trim();
    if let Ok(items) = serde_yaml::from_str::<Vec<String>>(v) {
        return items;
    }
    if !v.starts_with('[') {
        let wrapped = format!("[{}]", v);
        if let Ok(items) = serde_yaml::from_str::<Vec<String>>(&wrapped) {
            return items;
        }
    }
    // `[a, b, "c"]` 或 `a, b, c` 都接受
    let inner = v
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(v);
    inner
        .split(',')
        .map(|s| strip_quotes(s.trim()).to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 应用字段限长（不破坏 UTF-8 字符边界）。
fn clamp_tag(mut tag: PlanTag) -> PlanTag {
    tag.intent = tag.intent.map(|s| truncate_chars(&s, INTENT_MAX_CHARS));
    tag.followups = tag
        .followups
        .map(|s| truncate_chars(&s, FOLLOWUPS_MAX_CHARS));
    tag.tags = clamp_array(tag.tags, TAG_MAX_ITEMS, TAG_ITEM_MAX_CHARS);
    tag.scope = clamp_array(tag.scope, SCOPE_MAX_ITEMS, SCOPE_ITEM_MAX_CHARS);
    // risk 只接受 low/med/high，否则丢字段
    tag.risk = tag.risk.and_then(|s| {
        let lower = s.trim().to_ascii_lowercase();
        if matches!(lower.as_str(), "low" | "med" | "high") {
            Some(lower)
        } else {
            None
        }
    });
    tag
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        s.chars().take(max_chars).collect()
    }
}

fn clamp_array(items: Vec<String>, max_items: usize, max_item_chars: usize) -> Vec<String> {
    items
        .into_iter()
        .take(max_items)
        .map(|s| truncate_chars(s.trim(), max_item_chars))
        .filter(|s| !s.is_empty())
        .collect()
}

/// POST 已解析的标签到 cc-pane 主进程。
///
/// 复用 `session_start.rs:236-273` 的 ureq + Bearer + 750ms 超时模式。
/// 任何失败都只 `eprintln!`，不返回 Err（钩子归档主路径已成功）。
fn post_plan_tag(
    session_id: &str,
    plan_path: &str,
    archived_path: &Path,
    workspace_path: Option<&str>,
    project_path: Option<&str>,
    tag: &PlanTag,
) -> Result<(), String> {
    let endpoint = ApiEndpoint::resolve()?;

    let project_path_owned = project_path
        .map(|s| s.to_string())
        .or_else(|| {
            // 兜底：项目缓存层归档时从 archived_path 上溯到 .ccpanes 父目录
            // （工作空间层归档没有 .ccpanes 祖先，此时只能依赖 env）
            archived_path
                .ancestors()
                .find(|p| p.ends_with(".ccpanes"))
                .and_then(|p| p.parent())
                .map(|p| p.to_string_lossy().to_string())
        })
        .ok_or_else(|| "Cannot resolve projectPath".to_string())?;

    let body = serde_json::json!({
        "sessionId": session_id,
        "workspaceName": std::env::var("CC_PANES_WORKSPACE_NAME").ok(),
        "workspacePath": workspace_path,
        "projectPath": project_path_owned,
        "planPath": plan_path,
        "archivedPath": archived_path.to_string_lossy().to_string(),
        "tag": tag,
    });

    if let Err(e) = post_json(&endpoint, "/api/plan/tag", &body) {
        eprintln!("[ccpanes] plan-tag POST failed (non-fatal): {}", e);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_full_tag() {
        let content = r#"<!-- ccpanes-plan
intent: 测试 intent
tags: [a, b, "c"]
scope: [crate/x, crate/y]
risk: low
followups: 下次接 X
-->

# Plan title
hello
"#;
        let tag = extract_plan_tag(content).expect("tag should exist");
        assert_eq!(tag.intent.as_deref(), Some("测试 intent"));
        assert_eq!(tag.tags, vec!["a", "b", "c"]);
        assert_eq!(tag.scope, vec!["crate/x", "crate/y"]);
        assert_eq!(tag.risk.as_deref(), Some("low"));
        assert_eq!(tag.followups.as_deref(), Some("下次接 X"));
    }

    #[test]
    fn returns_none_when_tag_missing() {
        assert!(extract_plan_tag("# Plan\nno tag here").is_none());
    }

    #[test]
    fn returns_none_when_close_marker_missing() {
        let content = r#"<!-- ccpanes-plan
intent: foo

# Plan
"#;
        assert!(extract_plan_tag(content).is_none());
    }

    #[test]
    fn fallback_parses_yaml_broken_body() {
        // intent 写了一个 YAML 中视为 list 起始的字符，导致 yaml 解析失败 → 走 fallback
        let content = r#"<!-- ccpanes-plan
intent: { unclosed
tags: a, b
-->
"#;
        let tag = extract_plan_tag(content).expect("fallback should still work");
        assert!(tag.intent.is_some()); // intent 字符串照样收下
        assert_eq!(tag.tags, vec!["a", "b"]);
    }

    #[test]
    fn fallback_inline_array_handles_quoted_commas() {
        let content = r#"<!-- ccpanes-plan
intent: { unclosed
tags: ["a,b", c]
-->
"#;
        let tag = extract_plan_tag(content).expect("fallback should still work");
        assert_eq!(tag.tags, vec!["a,b", "c"]);
    }

    #[test]
    fn missing_individual_field_keeps_others() {
        let content = r#"<!-- ccpanes-plan
intent: only intent
-->
"#;
        let tag = extract_plan_tag(content).unwrap();
        assert_eq!(tag.intent.as_deref(), Some("only intent"));
        assert!(tag.tags.is_empty());
        assert!(tag.scope.is_empty());
        assert!(tag.risk.is_none());
        assert!(tag.followups.is_none());
    }

    #[test]
    fn clamps_intent_length() {
        let long = "x".repeat(500);
        let content = format!("<!-- ccpanes-plan\nintent: {}\n-->\n", long);
        let tag = extract_plan_tag(&content).unwrap();
        assert_eq!(tag.intent.unwrap().chars().count(), INTENT_MAX_CHARS);
    }

    #[test]
    fn clamps_tags_count_and_item_length() {
        let many: Vec<String> = (0..20).map(|i| format!("tag{}", i)).collect();
        let tags_line = format!("[{}]", many.join(", "));
        let content = format!("<!-- ccpanes-plan\nintent: x\ntags: {}\n-->\n", tags_line);
        let tag = extract_plan_tag(&content).unwrap();
        assert_eq!(tag.tags.len(), TAG_MAX_ITEMS);
    }

    #[test]
    fn rejects_unknown_risk() {
        let content = r#"<!-- ccpanes-plan
intent: x
risk: extreme
-->
"#;
        let tag = extract_plan_tag(content).unwrap();
        assert!(tag.risk.is_none());
    }

    #[test]
    fn ignores_tag_after_scan_window() {
        let mut filler = String::new();
        for _ in 0..TAG_SCAN_MAX_LINES + 10 {
            filler.push_str("filler line\n");
        }
        let content = format!("{}<!-- ccpanes-plan\nintent: late\n-->\n", filler);
        assert!(extract_plan_tag(&content).is_none());
    }

    /// 关键回归：plan 第一行超过 TAG_SCAN_MAX_BYTES（64KB）时，read_plan_head_bounded
    /// 必须直接 return None，不能把整个文件载入内存。
    #[test]
    fn read_plan_head_bounded_rejects_huge_single_line() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!("ccpanes-plan-test-{}.md", std::process::id()));
        let mut f = fs::File::create(&tmp).unwrap();
        let big = "x".repeat(TAG_SCAN_MAX_BYTES + 1024);
        writeln!(f, "{}", big).unwrap();
        writeln!(f, "<!-- ccpanes-plan\nintent: should_not_see\n-->").unwrap();
        drop(f);

        let result = read_plan_head_bounded(tmp.to_str().unwrap());
        // 超过单行字节预算 → None
        assert!(result.is_none());
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn read_plan_head_bounded_returns_content_within_budget() {
        use std::io::Write;
        let tmp =
            std::env::temp_dir().join(format!("ccpanes-plan-test-ok-{}.md", std::process::id()));
        let mut f = fs::File::create(&tmp).unwrap();
        writeln!(f, "<!-- ccpanes-plan").unwrap();
        writeln!(f, "intent: hello").unwrap();
        writeln!(f, "-->").unwrap();
        writeln!(f, "# Plan body").unwrap();
        drop(f);

        let result = read_plan_head_bounded(tmp.to_str().unwrap()).unwrap();
        assert!(result.contains("intent: hello"));
        let tag = extract_plan_tag(&result).unwrap();
        assert_eq!(tag.intent.as_deref(), Some("hello"));
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn read_plan_head_bounded_accepts_exact_byte_budget_at_eof() {
        use std::io::Write;
        let tmp =
            std::env::temp_dir().join(format!("ccpanes-plan-test-exact-{}.md", std::process::id()));
        let mut f = fs::File::create(&tmp).unwrap();
        write!(f, "{}", "x".repeat(TAG_SCAN_MAX_BYTES)).unwrap();
        drop(f);

        let result = read_plan_head_bounded(tmp.to_str().unwrap()).unwrap();
        assert_eq!(result.len(), TAG_SCAN_MAX_BYTES);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn read_plan_head_bounded_rejects_invalid_utf8() {
        use std::io::Write;
        let tmp =
            std::env::temp_dir().join(format!("ccpanes-plan-test-utf8-{}.md", std::process::id()));
        let mut f = fs::File::create(&tmp).unwrap();
        f.write_all(&[0xff, 0xfe, b'\n']).unwrap();
        drop(f);

        assert!(read_plan_head_bounded(tmp.to_str().unwrap()).is_none());
        let _ = fs::remove_file(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn archive_dir_candidates_reject_windows_path_on_unix() {
        assert!(archive_dir_candidates(Some(r"C:\repo"), Some("relative/repo")).is_empty());
        assert_eq!(
            archive_dir_candidates(None, Some("/tmp/repo")),
            vec![PathBuf::from("/tmp/repo/.ccpanes/.cache/plans")]
        );
    }

    #[test]
    fn archive_dir_candidates_prefer_workspace_dir_then_project_cache() {
        #[cfg(windows)]
        let (ws, project) = (r"C:\Users\me\.cc-panes\workspaces\team\plans", r"D:\repo");
        #[cfg(not(windows))]
        let (ws, project) = ("/home/me/.cc-panes/workspaces/team/plans", "/srv/repo");

        let candidates = archive_dir_candidates(Some(ws), Some(project));
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0], PathBuf::from(ws));
        assert_eq!(
            candidates[1],
            PathBuf::from(project)
                .join(".ccpanes")
                .join(".cache")
                .join("plans")
        );
        // 旧位置 <project>/.ccpanes/plans 不再是写入候选
        assert!(candidates
            .iter()
            .all(|c| !c.ends_with(Path::new(".ccpanes").join("plans"))));
        assert!(archive_dir_candidates(None, None).is_empty());
    }
}
