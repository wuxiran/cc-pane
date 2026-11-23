//! 五个 CLI 的目录结构：默认目录在哪、账号目录里哪些条目链接回默认目录、哪些必须隔离。
//!
//! 原则：**设置、技能、指令文件**共享（链接），**登录凭据和会话历史**隔离。
//! 这里只列「要链接的」（白名单）；没列的一律留在账号目录里，各账号各一份。
//! `ISOLATED` 是给测试和文档用的反向清单：这些名字永远不许出现在白名单里。

use std::path::{Path, PathBuf};

/// 一个 CLI 的登录目录规则。
#[derive(Debug, Clone, Copy)]
pub struct LoginCliLayout {
    pub cli_tool: &'static str,
    /// 把 CLI 指到账号目录的环境变量。
    pub dir_env_var: &'static str,
    /// 默认目录相对用户主目录的位置（环境变量没设时）。空串 = 主目录本身。
    pub default_rel_home: &'static str,
    /// 链接进账号目录的条目，相对「目录变量指向的那一层」。
    pub shared: &'static [&'static str],
    /// 登录凭据与会话历史：只为说明和测试列出，永不链接。
    pub isolated: &'static [&'static str],
    /// 登录命令的可执行文件名。
    pub executable: &'static str,
}

/// Claude Code：`CLAUDE_CONFIG_DIR` 替换 `~/.claude`。换目录后全局状态文件是
/// `<目录>/.claude.json`（里面有账号邮箱，也有用户级 MCP——它不共享）。
const CLAUDE: LoginCliLayout = LoginCliLayout {
    cli_tool: "claude",
    dir_env_var: "CLAUDE_CONFIG_DIR",
    default_rel_home: ".claude",
    shared: &[
        "settings.json",
        "keybindings.json",
        "CLAUDE.md",
        "skills",
        "commands",
        "agents",
        "rules",
        "output-styles",
        "hooks",
        "plugins",
    ],
    isolated: &[
        ".claude.json",
        ".credentials.json",
        "projects",
        "history.jsonl",
        "sessions",
        "todos",
        "shell-snapshots",
        "session-env",
        "file-history",
    ],
    executable: "claude",
};

/// Codex：`CODEX_HOME` 替换 `~/.codex`。
const CODEX: LoginCliLayout = LoginCliLayout {
    cli_tool: "codex",
    dir_env_var: "CODEX_HOME",
    default_rel_home: ".codex",
    shared: &[
        "config.toml",
        "AGENTS.md",
        "AGENTS.override.md",
        "skills",
        "prompts",
        "rules",
    ],
    isolated: &[
        "auth.json",
        "sessions",
        "archived_sessions",
        "history.jsonl",
        "session_index.jsonl",
        "memories",
    ],
    executable: "codex",
};

/// Gemini CLI：`GEMINI_CLI_HOME` 替换的是**用户主目录**，数据在它下面的 `.gemini` 里。
const GEMINI: LoginCliLayout = LoginCliLayout {
    cli_tool: "gemini",
    dir_env_var: "GEMINI_CLI_HOME",
    default_rel_home: "",
    shared: &[
        ".gemini/settings.json",
        ".gemini/GEMINI.md",
        ".gemini/AGENTS.md",
        ".gemini/skills",
        ".gemini/commands",
        ".gemini/extensions",
        ".gemini/policies",
        ".gemini/agents",
        ".agents/skills",
    ],
    isolated: &[
        ".gemini/oauth_creds.json",
        ".gemini/google_accounts.json",
        ".gemini/gemini-credentials.json",
        ".gemini/mcp-oauth-tokens.json",
        ".gemini/installation_id",
        ".gemini/tmp",
        ".gemini/history",
        ".gemini/projects.json",
    ],
    executable: "gemini",
};

/// Antigravity（`agy`）：账号目录替换 `~/.gemini`。agy 1.5.14 实测不读 `GEMINI_HOME`，
/// 真正生效的是启动 / 登录命令里的 `--gemini_dir <账号目录>`（适配器与 `login_command` 加）；
/// `GEMINI_HOME` 仍随环境带上，只作标记与兼容。只链接 T3 Code 验证过的技能目录和规则文件。
const ANTIGRAVITY: LoginCliLayout = LoginCliLayout {
    cli_tool: "antigravity",
    dir_env_var: "GEMINI_HOME",
    default_rel_home: ".gemini",
    shared: &[
        "AGENTS.md",
        "GEMINI.md",
        "config/skills.json",
        "config/skills",
        "antigravity-cli/skills",
    ],
    isolated: &[
        "oauth_creds.json",
        "google_accounts.json",
        "antigravity-acp",
        "antigravity-cli/conversations",
    ],
    executable: "agy",
};

/// Grok Build：`GROK_HOME` 替换 `~/.grok`。程序本体在默认目录的 `bin/` 下，不链接也不搬。
const GROK: LoginCliLayout = LoginCliLayout {
    cli_tool: "grok",
    dir_env_var: "GROK_HOME",
    default_rel_home: ".grok",
    shared: &[
        "config.toml",
        "AGENTS.md",
        "skills",
        "rules",
        "agents",
        "hooks",
    ],
    isolated: &["auth.json", "sessions", "bin"],
    executable: "grok",
};

const ALL: [&LoginCliLayout; 5] = [&CLAUDE, &CODEX, &GEMINI, &ANTIGRAVITY, &GROK];

pub fn layout_for(cli_tool: &str) -> Option<&'static LoginCliLayout> {
    ALL.iter()
        .copied()
        .find(|layout| layout.cli_tool == cli_tool)
}

impl LoginCliLayout {
    /// 这个 CLI 的默认目录：进程环境里设了目录变量就用它，否则在用户主目录下。
    pub fn default_dir(&self, home: &Path, env_dir: Option<&Path>) -> PathBuf {
        match env_dir {
            Some(dir) => dir.to_path_buf(),
            None if self.default_rel_home.is_empty() => home.to_path_buf(),
            None => home.join(self.default_rel_home),
        }
    }

    /// 账号信息 / 凭据文件所在的那一层（Gemini 是目录下的 `.gemini`，其余就是目录本身）。
    pub fn data_dir(&self, dir: &Path) -> PathBuf {
        if self.cli_tool == "gemini" {
            dir.join(".gemini")
        } else {
            dir.to_path_buf()
        }
    }

    /// 会话转录所在目录（会话索引 / 用量统计扫描用）。只有 Claude 和 Codex 有索引解析器。
    pub fn transcript_dir(&self, dir: &Path) -> Option<PathBuf> {
        match self.cli_tool {
            "claude" => Some(dir.join("projects")),
            "codex" => Some(dir.join("sessions")),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::provider::{login_dir_env_var, LOGIN_CLI_TOOLS};

    #[test]
    fn every_login_cli_has_a_layout_with_the_agreed_dir_variable() {
        for cli in LOGIN_CLI_TOOLS {
            let layout = layout_for(cli).unwrap_or_else(|| panic!("{cli} has no layout"));
            assert_eq!(Some(layout.dir_env_var), login_dir_env_var(cli));
            assert!(!layout.shared.is_empty());
        }
        assert!(layout_for("kimi").is_none());
    }

    /// 凭据和会话历史永远不在链接白名单里，也不会被某个共享目录「顺带」包进去。
    #[test]
    fn credentials_and_history_are_never_shared() {
        for layout in ALL {
            for isolated in layout.isolated {
                for shared in layout.shared {
                    assert_ne!(shared, isolated, "{} shares {isolated}", layout.cli_tool);
                    assert!(
                        !Path::new(isolated).starts_with(shared),
                        "{}: shared '{shared}' contains isolated '{isolated}'",
                        layout.cli_tool
                    );
                }
            }
            for shared in layout.shared {
                let lower = shared.to_ascii_lowercase();
                for needle in ["auth", "cred", "token", "session", "history"] {
                    assert!(
                        !lower.contains(needle),
                        "{}: '{shared}' looks like credentials or history",
                        layout.cli_tool
                    );
                }
            }
        }
    }

    #[test]
    fn default_dirs_follow_each_cli() {
        let home = Path::new("/home/u");
        let dir = |cli: &str| layout_for(cli).unwrap().default_dir(home, None);
        assert_eq!(dir("claude"), Path::new("/home/u/.claude"));
        assert_eq!(dir("codex"), Path::new("/home/u/.codex"));
        // GEMINI_CLI_HOME 替换的是主目录本身。
        assert_eq!(dir("gemini"), Path::new("/home/u"));
        assert_eq!(dir("antigravity"), Path::new("/home/u/.gemini"));
        assert_eq!(dir("grok"), Path::new("/home/u/.grok"));
        assert_eq!(
            layout_for("codex")
                .unwrap()
                .default_dir(home, Some(Path::new("/custom/codex"))),
            Path::new("/custom/codex")
        );
    }
}
