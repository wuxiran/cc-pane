//! Chromium 系浏览器的位置表、配置（profile）枚举与钥匙串读取（macOS）。

use serde::Serialize;
use std::path::{Path, PathBuf};

/// 一个 Chromium 系浏览器在 macOS 上的位置与钥匙串条目。
#[derive(Debug, Clone, Copy)]
pub struct ChromiumBrowser {
    pub id: &'static str,
    pub name: &'static str,
    /// 相对 `~/Library/Application Support` 的用户数据目录
    pub data_dir: &'static str,
    pub keychain_service: &'static str,
    pub keychain_account: &'static str,
}

pub const CHROMIUM_BROWSERS: &[ChromiumBrowser] = &[
    ChromiumBrowser {
        id: "chrome",
        name: "Google Chrome",
        data_dir: "Google/Chrome",
        keychain_service: "Chrome Safe Storage",
        keychain_account: "Chrome",
    },
    ChromiumBrowser {
        id: "chrome-beta",
        name: "Google Chrome Beta",
        data_dir: "Google/Chrome Beta",
        keychain_service: "Chrome Safe Storage",
        keychain_account: "Chrome",
    },
    ChromiumBrowser {
        id: "chrome-canary",
        name: "Google Chrome Canary",
        data_dir: "Google/Chrome Canary",
        keychain_service: "Chrome Safe Storage",
        keychain_account: "Chrome",
    },
    ChromiumBrowser {
        id: "brave",
        name: "Brave",
        data_dir: "BraveSoftware/Brave-Browser",
        keychain_service: "Brave Safe Storage",
        keychain_account: "Brave",
    },
    ChromiumBrowser {
        id: "edge",
        name: "Microsoft Edge",
        data_dir: "Microsoft Edge",
        keychain_service: "Microsoft Edge Safe Storage",
        keychain_account: "Microsoft Edge",
    },
    ChromiumBrowser {
        id: "arc",
        name: "Arc",
        data_dir: "Arc/User Data",
        keychain_service: "Arc Safe Storage",
        keychain_account: "Arc",
    },
    ChromiumBrowser {
        id: "chromium",
        name: "Chromium",
        data_dir: "Chromium",
        keychain_service: "Chromium Safe Storage",
        keychain_account: "Chromium",
    },
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImportProfile {
    /// 配置目录名（如 `Default`、`Profile 2`）
    pub id: String,
    /// 浏览器里显示的名字
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImportSource {
    pub id: String,
    pub name: String,
    pub profiles: Vec<BrowserImportProfile>,
}

pub fn find_browser(id: &str) -> Option<&'static ChromiumBrowser> {
    CHROMIUM_BROWSERS.iter().find(|b| b.id == id)
}

pub fn browser_root(app_support: &Path, browser: &ChromiumBrowser) -> PathBuf {
    app_support.join(browser.data_dir)
}

/// 解析 `Local State` 的 `profile.info_cache`；`Default` 排第一，其余按目录名。
pub fn parse_profiles(local_state_json: &str) -> Vec<BrowserImportProfile> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(local_state_json) else {
        return Vec::new();
    };
    let Some(cache) = value
        .pointer("/profile/info_cache")
        .and_then(|v| v.as_object())
    else {
        return Vec::new();
    };
    let mut profiles: Vec<_> = cache
        .iter()
        .filter(|(dir, _)| is_safe_profile_dir(dir))
        .map(|(dir, info)| BrowserImportProfile {
            id: dir.clone(),
            name: info
                .get("name")
                .and_then(|n| n.as_str())
                .filter(|n| !n.trim().is_empty())
                .unwrap_or(dir)
                .to_string(),
        })
        .collect();
    profiles.sort_by(|a, b| {
        (a.id != "Default")
            .cmp(&(b.id != "Default"))
            .then_with(|| natural_key(&a.id).cmp(&natural_key(&b.id)))
    });
    profiles
}

fn natural_key(dir: &str) -> (String, u64) {
    let digits: String = dir
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let n = digits
        .chars()
        .rev()
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    (
        dir.trim_end_matches(|c: char| c.is_ascii_digit())
            .to_string(),
        n,
    )
}

/// 只接受单层目录名，挡住 `..` / 路径分隔符。
pub fn is_safe_profile_dir(dir: &str) -> bool {
    !dir.is_empty()
        && dir != "."
        && dir != ".."
        && !dir.contains('/')
        && !dir.contains('\\')
        && !dir.contains('\0')
}

/// 列出本机装了（有 `Local State`）且至少一个配置的浏览器。
pub fn list_sources(app_support: &Path) -> Vec<BrowserImportSource> {
    CHROMIUM_BROWSERS
        .iter()
        .filter_map(|browser| {
            let root = browser_root(app_support, browser);
            let raw = std::fs::read_to_string(root.join("Local State")).ok()?;
            let profiles: Vec<_> = parse_profiles(&raw)
                .into_iter()
                .filter(|p| cookies_db_path(&root.join(&p.id)).is_some())
                .collect();
            (!profiles.is_empty()).then(|| BrowserImportSource {
                id: browser.id.to_string(),
                name: browser.name.to_string(),
                profiles,
            })
        })
        .collect()
}

/// 新版在 `Network/Cookies`，老版在配置根目录。
pub fn cookies_db_path(profile_dir: &Path) -> Option<PathBuf> {
    [
        profile_dir.join("Network/Cookies"),
        profile_dir.join("Cookies"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

#[derive(Debug, PartialEq, Eq)]
pub enum KeychainError {
    NotFound,
    Denied,
}

/// 读钥匙串里的 "<X> Safe Storage" 密码。会弹系统授权框（阻塞直到用户选择）。
/// 返回值只用于派生 key，调用方不得记录。
#[cfg(target_os = "macos")]
pub fn read_keychain_password(browser: &ChromiumBrowser) -> Result<Vec<u8>, KeychainError> {
    let run = |with_account: bool| {
        let mut cmd = std::process::Command::new("/usr/bin/security");
        cmd.args([
            "find-generic-password",
            "-w",
            "-s",
            browser.keychain_service,
        ]);
        if with_account {
            cmd.args(["-a", browser.keychain_account]);
        }
        cmd.output()
    };
    let mut output = run(true).map_err(|_| KeychainError::Denied)?;
    if !output.status.success() && output.status.code() == Some(44) {
        // 44 = errSecItemNotFound：部分安装的 account 名不一样，退回只按 service 查
        output = run(false).map_err(|_| KeychainError::Denied)?;
    }
    if output.status.success() {
        let mut pw = output.stdout;
        while matches!(pw.last(), Some(b'\n' | b'\r')) {
            pw.pop();
        }
        if pw.is_empty() {
            return Err(KeychainError::NotFound);
        }
        return Ok(pw);
    }
    if output.status.code() == Some(44) {
        Err(KeychainError::NotFound)
    } else {
        Err(KeychainError::Denied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_parses_local_state_profiles() {
        let json = r#"{"profile":{"info_cache":{
            "Profile 10":{"name":"Ten"},
            "Profile 2":{"name":"Work"},
            "Default":{"name":"Personal"},
            "../evil":{"name":"x"},
            "Profile 3":{"name":""}
        }}}"#;
        let profiles = parse_profiles(json);
        let ids: Vec<_> = profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["Default", "Profile 2", "Profile 3", "Profile 10"]);
        assert_eq!(profiles[0].name, "Personal");
        assert_eq!(profiles[2].name, "Profile 3");
        assert!(parse_profiles("not json").is_empty());
        assert!(parse_profiles("{}").is_empty());
    }

    #[test]
    fn browser_profile_dir_validation() {
        assert!(is_safe_profile_dir("Profile 2"));
        assert!(!is_safe_profile_dir(".."));
        assert!(!is_safe_profile_dir("a/b"));
        assert!(!is_safe_profile_dir(""));
    }

    #[test]
    fn browser_table_has_chrome() {
        let chrome = find_browser("chrome").unwrap();
        assert_eq!(chrome.keychain_service, "Chrome Safe Storage");
        assert!(find_browser("firefox").is_none());
    }

    /// 仅本机手动跑：`cargo test -p cc-panes --lib browser_lists_local -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn browser_lists_local_sources() {
        let app_support = dirs::home_dir()
            .unwrap()
            .join("Library/Application Support");
        let sources = list_sources(&app_support);
        println!("{sources:#?}");
        assert!(!sources.is_empty());
    }
}
