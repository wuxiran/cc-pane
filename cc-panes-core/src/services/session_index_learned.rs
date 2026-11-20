//! 会话转录目录的自动发现：不猜具体工具（reclaude、自定义 `CLAUDE_CONFIG_DIR`、账号切换器……），
//! 而是从 hook 上报的 `transcript_path` 反推它所在的根目录并记下来，之后的扫描一并覆盖。
//!
//! 另外顺带读 Codex 应用（桌面 / VS Code）给会话起的名字：`<CODEX_HOME>/session_index.jsonl`。

use super::session_index_roots::ScanRoot;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 从一条转录文件路径反推扫描根：
/// - Claude：`<root>/projects/<project>/<session>.jsonl` → `<root>/projects`
/// - Codex：`<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` → `<home>/sessions`
pub(super) fn transcript_root(path: &Path) -> Option<(&'static str, PathBuf)> {
    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return None;
    }
    let file_name = path.file_name()?.to_str()?;
    if file_name.starts_with("rollout-") {
        let sessions = path
            .ancestors()
            .skip(1)
            .find(|dir| dir.file_name().and_then(|n| n.to_str()) == Some("sessions"))?;
        return Some(("codex", sessions.to_path_buf()));
    }
    let projects = path.parent()?.parent()?;
    (projects.file_name().and_then(|n| n.to_str()) == Some("projects"))
        .then(|| ("claude", projects.to_path_buf()))
}

/// 把学到的根与当前进程的 `CLAUDE_CONFIG_DIR` 并进扫描列表（按路径去重）。
pub(super) fn merge_extra_roots(roots: &mut Vec<ScanRoot>, learned: Vec<(String, String)>) {
    let env_claude = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(|dir| ("claude".to_string(), PathBuf::from(dir).join("projects")));
    let extra = learned
        .into_iter()
        .map(|(cli, path)| (cli, PathBuf::from(path)))
        .chain(env_claude);
    for (cli, path) in extra {
        let cli_tool = match cli.as_str() {
            "claude" => "claude",
            "codex" => "codex",
            _ => continue,
        };
        if roots.iter().any(|root| same_dir(&root.path, &path)) || !path.is_dir() {
            continue;
        }
        roots.push(ScanRoot {
            cli_tool,
            path,
            source: "local",
            wsl_distro: None,
            wsl_default_distro: false,
        });
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b
        || matches!(
            (fs::canonicalize(a), fs::canonicalize(b)),
            (Ok(x), Ok(y)) if x == y
        )
}

/// Codex 应用起的会话名：`<home>/session_index.jsonl` 每行 `{id, thread_name}`，后写覆盖先写。
pub(super) fn codex_thread_names(sessions_root: &Path) -> HashMap<String, String> {
    let Some(index) = sessions_root
        .parent()
        .map(|home| home.join("session_index.jsonl"))
    else {
        return HashMap::new();
    };
    let Ok(text) = fs::read_to_string(index) else {
        return HashMap::new();
    };
    parse_codex_thread_names(&text)
}

fn parse_codex_thread_names(text: &str) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for line in text.lines() {
        let Ok(json) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let id = json.get("id").and_then(Value::as_str);
        let name = json
            .get("thread_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty());
        if let (Some(id), Some(name)) = (id, name) {
            names.insert(id.to_string(), name.to_string());
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_root_is_the_projects_dir() {
        let (cli, root) = transcript_root(Path::new(
            "/u/.rec/claude/accounts/1/config/projects/-Users-x-repo/abc.jsonl",
        ))
        .unwrap();
        assert_eq!(cli, "claude");
        assert_eq!(root, Path::new("/u/.rec/claude/accounts/1/config/projects"));
    }

    #[test]
    fn codex_root_is_the_sessions_dir() {
        let (cli, root) = transcript_root(Path::new(
            "/u/.codex/sessions/2026/11/20/rollout-2026-11-20T01-02-03-abc.jsonl",
        ))
        .unwrap();
        assert_eq!(cli, "codex");
        assert_eq!(root, Path::new("/u/.codex/sessions"));
    }

    #[test]
    fn unrelated_paths_are_ignored() {
        assert!(transcript_root(Path::new("/tmp/a/b/c.jsonl")).is_none());
        assert!(transcript_root(Path::new("/u/projects/x/abc.json")).is_none());
    }

    #[test]
    fn codex_thread_names_last_write_wins() {
        let names = parse_codex_thread_names(
            "{\"id\":\"a\",\"thread_name\":\"old\"}\n{\"id\":\"a\",\"thread_name\":\"起草委托书\"}\n{\"id\":\"b\",\"thread_name\":\"\"}\nnot json\n",
        );
        assert_eq!(names.get("a").map(String::as_str), Some("起草委托书"));
        assert!(!names.contains_key("b"));
    }
}
