//! OpenCode 的 MCP 隔离（docs/110 批 3）。
//!
//! OpenCode 没有「只用这些 MCP」的启动参数，但每个 server 条目都认 `enabled: false`。隔离时
//! 我们找出它会加载的配置文件里所有 server 名，把启动档没选中的逐个写成 `enabled: false`。
//!
//! **为什么走 `OPENCODE_CONFIG_CONTENT` 而不是每会话 `OPENCODE_CONFIG`**：1.17 的加载顺序
//! （`packages/opencode/src/config/config.ts`）是 全局 → `OPENCODE_CONFIG` → 项目
//! `opencode.json(c)` → `.opencode/opencode.json(c)` → `OPENCODE_CONFIG_CONTENT`，逐层 deep
//! merge。写在 `OPENCODE_CONFIG` 里的 `enabled:false` 会被项目文件里显式的 `enabled:true`
//! 盖回去；`OPENCODE_CONFIG_CONTENT` 排在项目文件之后，能压住它（1.17.11 实测，docs/110 §7）。
//! 之后还会合并的只有组织账号下发的远程配置与 MDM 托管配置——那是管理员的强制策略，不在
//! 隔离范围内。
//!
//! 发现范围与 `ConfigPaths`（`config/paths.ts`）一致：全局 `config.json` / `opencode.json(c)`，
//! 启动目录向上到 git 根的 `opencode.json(c)` 与 `.opencode/opencode.json(c)`，`~/.opencode/`，
//! 以及 `OPENCODE_CONFIG_DIR`。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tracing::warn;

use crate::CliAdapterContext;

pub(crate) const CONTENT_ENV: &str = "OPENCODE_CONFIG_CONTENT";

/// 本次会话要注入的 `OPENCODE_CONFIG_CONTENT`（不隔离 / 没有要禁用的 server 时 None）。
///
/// `injected` 是我们自己写进每会话配置的 server 名，永不禁用；`existing` 是父进程里已有的
/// `OPENCODE_CONFIG_CONTENT`——合并进去而不是覆盖。它解析不了时原样保留并告警：用户的内联
/// 配置比隔离更重要，丢了它会让会话行为整体变样。
pub(crate) fn isolation_content(
    ctx: &CliAdapterContext,
    launch_dir: &Path,
    injected: &BTreeSet<String>,
    existing: Option<&str>,
) -> Option<String> {
    if !ctx.disable_unlisted_mcp_servers {
        return None;
    }
    let disabled: Vec<String> = discover_server_names(launch_dir)
        .into_iter()
        .filter(|name| !injected.contains(name))
        .filter(|name| !ctx.allowed_mcp_server_ids.contains(name))
        .collect();
    if disabled.is_empty() {
        return None;
    }
    let mut root = match existing.map(str::trim).filter(|text| !text.is_empty()) {
        None => Map::new(),
        Some(text) => match parse_jsonc(text) {
            Some(Value::Object(map)) => map,
            _ => {
                warn!(
                    "opencode: existing {CONTENT_ENV} is not a JSON object; MCP isolation skipped"
                );
                return None;
            }
        },
    };
    let mcp = root
        .entry("mcp")
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(mcp) = mcp else {
        warn!("opencode: existing {CONTENT_ENV} has a non-object `mcp`; MCP isolation skipped");
        return None;
    };
    for name in disabled {
        let entry = mcp.entry(name).or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(entry) = entry {
            entry.insert("enabled".to_string(), Value::Bool(false));
        }
    }
    serde_json::to_string(&Value::Object(root)).ok()
}

/// OpenCode 会读的全部配置文件里出现过的 MCP server 名。
pub(crate) fn discover_server_names(launch_dir: &Path) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for path in candidate_files(launch_dir) {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        match parse_jsonc(&text) {
            Some(config) => collect_names(&config, &mut names),
            None => warn!(
                path = %path.display(),
                "opencode: unreadable config while collecting MCP names for isolation"
            ),
        }
    }
    names
}

fn collect_names(config: &Value, names: &mut BTreeSet<String>) {
    let Some(mcp) = config.get("mcp").and_then(Value::as_object) else {
        return;
    };
    for (name, entry) in mcp {
        if entry.is_object() {
            names.insert(name.clone());
        }
    }
}

fn candidate_files(launch_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let config_root = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")));
    if let Some(global) = config_root.map(|root| root.join("opencode")) {
        files.push(global.join("config.json"));
        push_pair(&mut files, &global);
    }
    for dir in project_dirs(launch_dir) {
        push_pair(&mut files, &dir);
        push_pair(&mut files, &dir.join(".opencode"));
    }
    if let Some(home) = dirs::home_dir() {
        push_pair(&mut files, &home.join(".opencode"));
    }
    if let Some(dir) = std::env::var_os("OPENCODE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        push_pair(&mut files, Path::new(&dir));
    }
    files
}

fn push_pair(files: &mut Vec<PathBuf>, dir: &Path) {
    files.push(dir.join("opencode.json"));
    files.push(dir.join("opencode.jsonc"));
}

/// 启动目录向上到（含）最近的 git 根；不在仓库里就一路到文件系统根（与 `afs.up` 一致）。
fn project_dirs(launch_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for dir in launch_dir.ancestors() {
        if dir.as_os_str().is_empty() {
            break;
        }
        dirs.push(dir.to_path_buf());
        if dir.join(".git").exists() {
            break;
        }
    }
    dirs
}

/// 宽松的 JSONC：去掉 `//` 与 `/* */` 注释和对象 / 数组末尾的逗号后按 JSON 解析。
pub(crate) fn parse_jsonc(text: &str) -> Option<Value> {
    serde_json::from_str(&strip_jsonc(text)).ok()
}

fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            i = copy_string(&chars, i, &mut out);
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
            continue;
        }
        if c == ',' && next_significant(&chars, i + 1).is_some_and(|n| n == '}' || n == ']') {
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// 原样拷贝一个字符串字面量（含转义），返回其后的位置。
fn copy_string(chars: &[char], start: usize, out: &mut String) -> usize {
    out.push('"');
    let mut i = start + 1;
    while i < chars.len() {
        let c = chars[i];
        out.push(c);
        i += 1;
        if c == '\\' {
            if let Some(&escaped) = chars.get(i) {
                out.push(escaped);
                i += 1;
            }
        } else if c == '"' {
            break;
        }
    }
    i
}

/// 跳过空白与注释后的下一个字符。
fn next_significant(chars: &[char], mut i: usize) -> Option<char> {
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else {
            return Some(c);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn jsonc_comments_and_trailing_commas_are_tolerated() {
        let text = r#"{
            // line comment with "quote"
            "mcp": { /* block */ "a": { "command": ["x // not a comment"], }, },
            "url": "http://h/*keep*/",
        }"#;
        let value = parse_jsonc(text).expect("parses");
        assert_eq!(value["mcp"]["a"]["command"][0], "x // not a comment");
        assert_eq!(value["url"], "http://h/*keep*/");
    }

    #[test]
    fn project_walk_stops_at_git_root() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let nested = repo.join("pkg").join("web");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(repo.join(".git")).unwrap();
        // 仓库外的配置不属于这个项目
        fs::write(
            root.path().join("opencode.json"),
            r#"{"mcp":{"outside":{"type":"local","command":["x"]}}}"#,
        )
        .unwrap();
        fs::write(
            repo.join("opencode.jsonc"),
            "{\"mcp\":{\"repo-level\":{\"type\":\"local\",\"command\":[\"x\"]},}}",
        )
        .unwrap();
        fs::create_dir_all(nested.join(".opencode")).unwrap();
        fs::write(
            nested.join(".opencode").join("opencode.json"),
            r#"{"mcp":{"dot-dir":{"type":"remote","url":"http://x"},"not-a-server":true}}"#,
        )
        .unwrap();
        let names = discover_server_names(&nested);
        assert!(names.contains("repo-level"));
        assert!(names.contains("dot-dir"));
        assert!(!names.contains("outside"));
        assert!(!names.contains("not-a-server"));
    }

    #[test]
    fn existing_content_is_merged_and_unparseable_content_is_kept() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(
            repo.join("opencode.json"),
            r#"{"mcp":{"user":{"type":"local","command":["u"]},"kept":{"type":"local","command":["k"]},"ours":{"type":"local","command":["o"]}}}"#,
        )
        .unwrap();
        let mut ctx = crate::tests_support::bare_context(root.path());
        let injected = BTreeSet::from(["ours".to_string()]);
        assert!(isolation_content(&ctx, &repo, &injected, None).is_none());

        ctx.disable_unlisted_mcp_servers = true;
        ctx.allowed_mcp_server_ids = vec!["kept".to_string()];
        let content = isolation_content(&ctx, &repo, &injected, Some(r#"{"theme":"x"}"#)).unwrap();
        let value: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(value["theme"], "x");
        assert_eq!(value["mcp"]["user"]["enabled"], false);
        assert!(value["mcp"].get("kept").is_none());
        assert!(value["mcp"].get("ours").is_none());

        assert!(isolation_content(&ctx, &repo, &injected, Some("not json")).is_none());
    }
}
