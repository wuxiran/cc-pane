//! 进程级的「登录账号目录来源」：给无状态的会话读取函数（`claude_session_service` /
//! `codex_session_service`）用，让它们在默认目录之外也扫到各登录账号的目录。
//!
//! 只记一个对 `ProviderService` 的弱引用；没注册（测试、CLI 工具）时就只扫默认目录。
//! 会话历史本身仍按账号隔离存放——这里只是**读**时把各账号的目录一起列出来。

use super::{login_account_roots, LoginAccountRoot};
use crate::services::ProviderService;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

fn slot() -> &'static Mutex<Option<Weak<ProviderService>>> {
    static SLOT: OnceLock<Mutex<Option<Weak<ProviderService>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// 注册账号目录来源（应用启动时调用一次；重复调用以最后一次为准）。
pub fn register_account_root_source(providers: &Arc<ProviderService>) {
    let mut guard = slot().lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Arc::downgrade(providers));
}

/// 某个 CLI 各登录账号的转录目录。没注册来源、来源已释放时返回空。
pub fn registered_account_roots(cli_tool: &str) -> Vec<LoginAccountRoot> {
    let providers = slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(Weak::upgrade);
    let Some(providers) = providers else {
        return Vec::new();
    };
    login_account_roots(&providers.list_providers())
        .into_iter()
        .filter(|root| root.cli_tool == cli_tool)
        .collect()
}

/// 一个会话转录扫描根：默认目录（不带账号）或某个登录账号的目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionScanRoot {
    /// 转录目录（Claude 的 `projects`、Codex 的 `sessions`）。
    pub dir: PathBuf,
    /// 所属登录账号；默认目录为 `None`。
    pub account_id: Option<String>,
    pub account_name: Option<String>,
}

/// 默认转录目录 + 已注册来源里该 CLI 各登录账号的转录目录。同一目录只出现一次
/// （账号目录手填成默认目录时以默认目录为准）。
pub fn session_scan_roots(cli_tool: &str, default_dir: Option<PathBuf>) -> Vec<SessionScanRoot> {
    session_scan_roots_from(default_dir, registered_account_roots(cli_tool))
}

/// [`session_scan_roots`] 的纯函数部分（测试用）。
pub fn session_scan_roots_from(
    default_dir: Option<PathBuf>,
    accounts: Vec<LoginAccountRoot>,
) -> Vec<SessionScanRoot> {
    let mut roots: Vec<SessionScanRoot> = default_dir
        .into_iter()
        .map(|dir| SessionScanRoot {
            dir,
            account_id: None,
            account_name: None,
        })
        .collect();
    for account in accounts {
        let key = same_dir_key(&account.transcript_dir);
        if roots.iter().any(|root| same_dir_key(&root.dir) == key) {
            continue;
        }
        roots.push(SessionScanRoot {
            dir: account.transcript_dir,
            account_id: Some(account.account_id),
            account_name: Some(account.account_name),
        });
    }
    roots
}

fn same_dir_key(dir: &Path) -> PathBuf {
    std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, transcript_dir: PathBuf) -> LoginAccountRoot {
        LoginAccountRoot {
            cli_tool: "claude".to_string(),
            provider_id: "p".to_string(),
            account_id: id.to_string(),
            account_name: format!("name-{id}"),
            dir: transcript_dir.parent().unwrap().to_path_buf(),
            transcript_dir,
        }
    }

    #[test]
    fn default_root_comes_first_and_duplicate_dirs_collapse() {
        let temp = tempfile::tempdir().unwrap();
        let default = temp.path().join("default/projects");
        let other = temp.path().join("acc/projects");
        std::fs::create_dir_all(&default).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let roots = session_scan_roots_from(
            Some(default.clone()),
            vec![
                account("same", default.clone()),
                account("a", other.clone()),
            ],
        );
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].dir, default);
        assert!(roots[0].account_id.is_none());
        assert_eq!(roots[1].dir, other);
        assert_eq!(roots[1].account_name.as_deref(), Some("name-a"));
    }

    #[test]
    fn unregistered_source_yields_no_account_roots() {
        // 测试进程里不注册来源：只剩默认目录。
        let roots = session_scan_roots_from(Some(PathBuf::from("/nowhere")), Vec::new());
        assert_eq!(roots.len(), 1);
    }
}
