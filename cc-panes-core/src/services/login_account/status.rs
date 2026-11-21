//! 登录状态：这个账号登录了没有、是哪个号。
//!
//! 只做两件事：读账号目录里的**账号信息**（邮箱、过期时间），以及查凭据**在不在**
//! （文件是否存在、钥匙串条目是否存在）。不读出、不保存、不记录任何凭据内容：
//! - 反序列化用的结构体只声明非敏感字段，令牌字段根本不进内存里的结构；
//! - Codex 的邮箱只能从 `auth.json` 里身份令牌的声明段取，取完即丢，令牌本身不留；
//! - 钥匙串只用「按名字查属性」（不带 `-w`），拿不到也不会请求条目内容。
//!
//! 读不出来就是「未知」，不猜。

use super::layout::LoginCliLayout;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginState {
    LoggedIn,
    NotLoggedIn,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginAccountStatus {
    pub state: LoginState,
    /// 邮箱或账号名。读不到为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    /// 凭据在哪找到的：`file` / `keychain`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_source: Option<String>,
    /// 凭据过期时间（RFC 3339），只有 CLI 在账号信息里写了才有。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// 「未知」的原因码，给界面挑文案用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl LoginAccountStatus {
    fn new(state: LoginState) -> Self {
        Self {
            state,
            identity: None,
            credential_source: None,
            expires_at: None,
            reason: None,
        }
    }

    pub fn unknown(reason: &str) -> Self {
        Self {
            reason: Some(reason.to_string()),
            ..Self::new(LoginState::Unknown)
        }
    }

    fn logged_in(source: &str, identity: Option<String>) -> Self {
        Self {
            identity,
            credential_source: Some(source.to_string()),
            ..Self::new(LoginState::LoggedIn)
        }
    }

    fn not_logged_in() -> Self {
        Self::new(LoginState::NotLoggedIn)
    }
}

/// 查钥匙串条目在不在。`Some(true/false)` = 查到了结论；`None` = 这个环境查不了。
pub trait KeychainProbe: Send + Sync {
    fn item_exists(&self, service: &str, account: Option<&str>) -> Option<bool>;
}

/// 系统钥匙串。目前只有 macOS 有实现：Claude Code 和 Codex 在 macOS 上把登录放钥匙串。
/// 其他平台返回 `None`（这两个 CLI 在那里用目录里的凭据文件）。
pub struct SystemKeychainProbe;

impl KeychainProbe for SystemKeychainProbe {
    #[cfg(target_os = "macos")]
    fn item_exists(&self, service: &str, account: Option<&str>) -> Option<bool> {
        // 不带 `-w` / `-g`：只查属性，不请求条目内容，也不会弹授权框。
        let mut command = std::process::Command::new("/usr/bin/security");
        command.arg("find-generic-password").arg("-s").arg(service);
        if let Some(account) = account {
            command.arg("-a").arg(account);
        }
        let output = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .ok()?;
        if output.status.success() {
            return Some(true);
        }
        // 44 = errSecItemNotFound。其余退出码（钥匙串锁着、被拒）一律算查不了。
        (output.status.code() == Some(44)).then_some(false)
    }

    #[cfg(not(target_os = "macos"))]
    fn item_exists(&self, _service: &str, _account: Option<&str>) -> Option<bool> {
        None
    }
}

/// Claude Code 在钥匙串里的条目名：默认目录是 `Claude Code-credentials`，
/// 换了 `CLAUDE_CONFIG_DIR` 后带上目录路径 SHA-256 的前 8 位十六进制。
pub fn claude_keychain_service(config_dir: Option<&str>) -> String {
    match config_dir {
        Some(dir) => {
            let digest = Sha256::digest(dir.as_bytes());
            format!("Claude Code-credentials-{}", &hex(&digest)[..8])
        }
        None => "Claude Code-credentials".to_string(),
    }
}

/// Codex 在钥匙串里的条目：服务名 `Codex Auth`，账号名 `cli|` + 规范化后的
/// `CODEX_HOME` 路径 SHA-256 的前 16 位十六进制。
pub fn codex_keychain_account(codex_home: &Path) -> String {
    let canonical = fs::canonicalize(codex_home).unwrap_or_else(|_| codex_home.to_path_buf());
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    format!("cli|{}", &hex(&digest)[..16])
}

pub const CODEX_KEYCHAIN_SERVICE: &str = "Codex Auth";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    // 账号信息文件都很小；异常大的文件不读。
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 8 * 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn nonblank(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 查询一个登录目录的状态。
///
/// - `dir`：目录变量指向的那一层；`None` = 默认登录（CLI 的默认目录）。
/// - `default_dir`：该 CLI 的默认目录（`dir` 为 `None` 时读它）。
/// - `home`：用户主目录（Claude 默认登录的全局状态文件在 `~/.claude.json`）。
pub fn login_status(
    layout: &LoginCliLayout,
    dir: Option<&Path>,
    default_dir: &Path,
    home: &Path,
    keychain: &dyn KeychainProbe,
) -> LoginAccountStatus {
    let effective = dir.unwrap_or(default_dir);
    match layout.cli_tool {
        "claude" => claude_status(dir, effective, home, keychain),
        "codex" => codex_status(effective, keychain),
        "gemini" => gemini_status(&layout.data_dir(effective)),
        "grok" => grok_status(effective),
        // Antigravity 登录后由 CLI 自己报告账号；它把凭据放在哪个文件里没有核实过，不猜。
        "antigravity" => LoginAccountStatus::unknown("antigravity_reports_in_cli"),
        _ => LoginAccountStatus::unknown("unsupported_cli"),
    }
}

#[derive(Deserialize)]
struct ClaudeGlobalState {
    #[serde(default, rename = "oauthAccount")]
    oauth_account: Option<ClaudeOauthAccount>,
}

#[derive(Deserialize)]
struct ClaudeOauthAccount {
    #[serde(default, rename = "emailAddress")]
    email_address: Option<String>,
}

fn claude_status(
    account_dir: Option<&Path>,
    effective: &Path,
    home: &Path,
    keychain: &dyn KeychainProbe,
) -> LoginAccountStatus {
    // 换了目录后全局状态文件在目录里；默认登录在主目录下。
    let state_path = match account_dir {
        Some(dir) => dir.join(".claude.json"),
        None => home.join(".claude.json"),
    };
    let identity = read_json::<ClaudeGlobalState>(&state_path)
        .and_then(|state| state.oauth_account)
        .and_then(|account| nonblank(account.email_address));

    if effective.join(".credentials.json").is_file() {
        return LoginAccountStatus::logged_in("file", identity);
    }
    let service = claude_keychain_service(account_dir.and_then(Path::to_str));
    match keychain.item_exists(&service, None) {
        Some(true) => LoginAccountStatus::logged_in("keychain", identity),
        Some(false) => LoginAccountStatus::not_logged_in(),
        // 没有钥匙串可查的平台，凭据只会在文件里：文件不在就是没登录。
        None if !cfg!(target_os = "macos") => LoginAccountStatus::not_logged_in(),
        None => LoginAccountStatus {
            identity,
            ..LoginAccountStatus::unknown("keychain_unavailable")
        },
    }
}

/// `auth.json` 里只取这两样：登录方式的标记，和身份令牌（用来取邮箱声明）。
/// 访问令牌、刷新令牌、API key 都没有声明成字段，不会被反序列化。
#[derive(Deserialize)]
struct CodexAuthFile {
    #[serde(default)]
    tokens: Option<CodexTokens>,
}

#[derive(Deserialize)]
struct CodexTokens {
    #[serde(default)]
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct IdTokenClaims {
    #[serde(default)]
    email: Option<String>,
}

/// 从身份令牌的声明段取邮箱。令牌本身不保留、不外传。
fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    nonblank(serde_json::from_slice::<IdTokenClaims>(&bytes).ok()?.email)
}

fn codex_status(home: &Path, keychain: &dyn KeychainProbe) -> LoginAccountStatus {
    let auth_path = home.join("auth.json");
    if auth_path.is_file() {
        let identity = read_json::<CodexAuthFile>(&auth_path)
            .and_then(|auth| auth.tokens)
            .and_then(|tokens| tokens.id_token)
            .and_then(|token| email_from_id_token(&token));
        return LoginAccountStatus::logged_in("file", identity);
    }
    match keychain.item_exists(CODEX_KEYCHAIN_SERVICE, Some(&codex_keychain_account(home))) {
        // 凭据在钥匙串里：登录了，但是哪个号要读条目内容才知道——不读。
        Some(true) => LoginAccountStatus::logged_in("keychain", None),
        Some(false) => LoginAccountStatus::not_logged_in(),
        None if !cfg!(target_os = "macos") => LoginAccountStatus::not_logged_in(),
        None => LoginAccountStatus::unknown("keychain_unavailable"),
    }
}

#[derive(Deserialize)]
struct GoogleAccounts {
    #[serde(default)]
    active: Option<String>,
}

fn gemini_status(data_dir: &Path) -> LoginAccountStatus {
    let identity = read_json::<GoogleAccounts>(&data_dir.join("google_accounts.json"))
        .and_then(|accounts| nonblank(accounts.active));
    if data_dir.join("oauth_creds.json").is_file() {
        return LoginAccountStatus::logged_in("file", identity);
    }
    if !data_dir.is_dir() {
        // 目录还没被 CLI 用过。
        return LoginAccountStatus::not_logged_in();
    }
    // 没有 OAuth 凭据文件：可能没登录，也可能用的是 API key / 加密存储（那种不落这个文件）。
    match identity {
        Some(identity) => LoginAccountStatus {
            identity: Some(identity),
            ..LoginAccountStatus::unknown("credential_file_missing")
        },
        None => LoginAccountStatus::not_logged_in(),
    }
}

/// Grok 的 `auth.json` 是「签发方 → 一条登录」的表；每条只取邮箱和过期时间，密钥字段不声明。
#[derive(Deserialize)]
struct GrokCredential {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
}

fn grok_status(home: &Path) -> LoginAccountStatus {
    let auth_path = home.join("auth.json");
    if !auth_path.is_file() {
        return LoginAccountStatus::not_logged_in();
    }
    let Some(entries) = read_json::<std::collections::BTreeMap<String, GrokCredential>>(&auth_path)
    else {
        // 文件在但读不懂（格式变了）：不猜。
        return LoginAccountStatus::unknown("account_file_unreadable");
    };
    let Some(entry) = entries.into_values().next() else {
        return LoginAccountStatus::not_logged_in();
    };
    LoginAccountStatus {
        expires_at: nonblank(entry.expires_at),
        ..LoginAccountStatus::logged_in("file", nonblank(entry.email))
    }
}
