//! 登录状态：这个账号登录了没有、是哪个号。
//!
//! 只做两件事：读账号目录里的**账号信息**（邮箱、过期时间），以及查凭据**在不在**
//! （文件是否存在、钥匙串条目是否存在）。不读出、不保存、不记录任何凭据内容：
//! - 反序列化用的结构体只声明非敏感字段，令牌字段根本不进内存里的结构；
//! - Codex 的邮箱只能从 `auth.json` 里身份令牌的声明段取，取完即丢，令牌本身不留；
//! - 钥匙串只用「按名字查属性」（不带 `-w`），拿不到也不会请求条目内容。
//!
//! 读不出来就是「未知」，不猜。
//!
//! 套餐 / 认证方式（`plan` / `auth_kind`）同样只取账号信息里的非敏感字段：Claude 的
//! `oauthAccount.billingType`、凭据文件里的 `claudeAiOauth.subscriptionType`（只声明这一个字段）；
//! Codex 的 `auth_mode`、`OPENAI_API_KEY` 是否非空（只留布尔）、身份令牌里的 `chatgpt_plan_type` 声明。

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
    /// 套餐 / 登录方式的显示名（如 `Claude Team`、`ChatGPT Plus`、`API Key`）。读不到为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// 认证方式代码：`oauth`（Claude.ai 订阅登录）/ `chatgpt` / `api_key`，或 CLI 写的原值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_kind: Option<String>,
}

impl LoginAccountStatus {
    fn new(state: LoginState) -> Self {
        Self {
            state,
            identity: None,
            credential_source: None,
            expires_at: None,
            reason: None,
            plan: None,
            auth_kind: None,
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
    #[serde(default, rename = "billingType")]
    billing_type: Option<String>,
}

/// `.credentials.json` 里只声明套餐字段；令牌字段不声明，不会被反序列化。
#[derive(Deserialize)]
struct ClaudeCredentialsFile {
    #[serde(default, rename = "claudeAiOauth")]
    claude_ai_oauth: Option<ClaudeAiOauthPlan>,
}

#[derive(Deserialize)]
struct ClaudeAiOauthPlan {
    #[serde(default, rename = "subscriptionType")]
    subscription_type: Option<String>,
}

/// `snake_case` / `kebab-case` 原值 → 每词首字母大写。
fn title_case(raw: &str) -> String {
    raw.split(['_', '-', ' '])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Claude 套餐名：`subscriptionType`（pro / max / team / enterprise）优先，
/// 没有就用 `billingType` 原值的首字母大写形式。
fn claude_plan_label(subscription: Option<&str>, billing: Option<&str>) -> Option<String> {
    if let Some(subscription) = subscription {
        let label = match subscription.to_ascii_lowercase().as_str() {
            "free" => "Claude Free".to_string(),
            "pro" => "Claude Pro".to_string(),
            "max" => "Claude Max".to_string(),
            "team" => "Claude Team".to_string(),
            "enterprise" => "Claude Enterprise".to_string(),
            _ => format!("Claude {}", title_case(subscription)),
        };
        return Some(label);
    }
    billing.map(title_case).filter(|label| !label.is_empty())
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
    let oauth_account = read_json::<ClaudeGlobalState>(&state_path).and_then(|s| s.oauth_account);
    let has_oauth_account = oauth_account.is_some();
    let (identity, billing) = oauth_account
        .map(|account| {
            (
                nonblank(account.email_address),
                nonblank(account.billing_type),
            )
        })
        .unwrap_or_default();
    let with_plan = |status: LoginAccountStatus, subscription: Option<String>| LoginAccountStatus {
        plan: claude_plan_label(subscription.as_deref(), billing.as_deref()),
        auth_kind: has_oauth_account.then(|| "oauth".to_string()),
        ..status
    };

    let credentials_path = effective.join(".credentials.json");
    if credentials_path.is_file() {
        let subscription = read_json::<ClaudeCredentialsFile>(&credentials_path)
            .and_then(|file| file.claude_ai_oauth)
            .and_then(|oauth| nonblank(oauth.subscription_type));
        return with_plan(
            LoginAccountStatus::logged_in("file", identity),
            subscription,
        );
    }
    let service = claude_keychain_service(account_dir.and_then(Path::to_str));
    match keychain.item_exists(&service, None) {
        // 钥匙串里的条目内容（含套餐）不读：套餐只能来自 `billingType`。
        Some(true) => with_plan(LoginAccountStatus::logged_in("keychain", identity), None),
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
    #[serde(default)]
    auth_mode: Option<String>,
    /// 只记「有没有非空的 API key」，值本身不留。
    #[serde(
        default,
        rename = "OPENAI_API_KEY",
        deserialize_with = "deserialize_non_empty_flag"
    )]
    has_api_key: bool,
}

fn deserialize_non_empty_flag<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value
        .as_ref()
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty()))
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
    #[serde(default)]
    chatgpt_plan_type: Option<String>,
    #[serde(default, rename = "https://api.openai.com/auth")]
    openai_auth: Option<OpenAiAuthClaims>,
}

#[derive(Deserialize)]
struct OpenAiAuthClaims {
    #[serde(default)]
    chatgpt_plan_type: Option<String>,
}

/// 从身份令牌声明段取出的非敏感字段。令牌本身不保留、不外传；不校验签名、不联网。
#[derive(Default)]
struct IdTokenInfo {
    email: Option<String>,
    plan_type: Option<String>,
}

fn id_token_info(id_token: &str) -> Option<IdTokenInfo> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims = serde_json::from_slice::<IdTokenClaims>(&bytes).ok()?;
    let plan_type = claims
        .openai_auth
        .and_then(|auth| nonblank(auth.chatgpt_plan_type))
        .or_else(|| nonblank(claims.chatgpt_plan_type));
    Some(IdTokenInfo {
        email: nonblank(claims.email),
        plan_type,
    })
}

fn chatgpt_label(plan_type: Option<&str>) -> String {
    match plan_type {
        Some(plan) => format!("ChatGPT {}", title_case(plan)),
        None => "ChatGPT".to_string(),
    }
}

/// Codex 的登录方式：`auth_mode` 优先；没有就看身份令牌（ChatGPT 登录），再看 API key。
fn codex_plan(
    auth: &CodexAuthFile,
    token: Option<&IdTokenInfo>,
) -> (Option<String>, Option<String>) {
    let plan_type = token.and_then(|info| info.plan_type.as_deref());
    if let Some(mode) = auth
        .auth_mode
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        return match mode.to_ascii_lowercase().as_str() {
            "chatgpt" => (Some(chatgpt_label(plan_type)), Some("chatgpt".to_string())),
            "apikey" | "api_key" => (Some("API Key".to_string()), Some("api_key".to_string())),
            _ => (Some(title_case(mode)), Some(mode.to_string())),
        };
    }
    let has_id_token = auth
        .tokens
        .as_ref()
        .and_then(|tokens| tokens.id_token.as_deref())
        .is_some_and(|token| !token.trim().is_empty());
    if has_id_token {
        return (Some(chatgpt_label(plan_type)), Some("chatgpt".to_string()));
    }
    if auth.has_api_key {
        return (Some("API Key".to_string()), Some("api_key".to_string()));
    }
    (None, None)
}

fn codex_status(home: &Path, keychain: &dyn KeychainProbe) -> LoginAccountStatus {
    let auth_path = home.join("auth.json");
    if auth_path.is_file() {
        let Some(auth) = read_json::<CodexAuthFile>(&auth_path) else {
            return LoginAccountStatus::logged_in("file", None);
        };
        let token = auth
            .tokens
            .as_ref()
            .and_then(|tokens| tokens.id_token.as_deref())
            .and_then(id_token_info);
        let (plan, auth_kind) = codex_plan(&auth, token.as_ref());
        let identity = token.and_then(|info| info.email);
        return LoginAccountStatus {
            plan,
            auth_kind,
            ..LoginAccountStatus::logged_in("file", identity)
        };
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

#[cfg(test)]
mod plan_tests {
    use super::*;

    struct NoKeychain;
    impl KeychainProbe for NoKeychain {
        fn item_exists(&self, _service: &str, _account: Option<&str>) -> Option<bool> {
            Some(false)
        }
    }

    fn jwt(claims: serde_json::Value) -> String {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.sig",
            engine.encode(br#"{"alg":"none"}"#),
            engine.encode(claims.to_string())
        )
    }

    fn claude_layout() -> &'static LoginCliLayout {
        super::super::layout_for("claude").unwrap()
    }

    #[test]
    fn claude_plan_prefers_subscription_type_and_never_returns_tokens() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("acct");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"a@b.co","billingType":"stripe_subscription"}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-secret","refreshToken":"rt-secret","subscriptionType":"team"}}"#,
        )
        .unwrap();
        let status = login_status(claude_layout(), Some(&dir), &dir, temp.path(), &NoKeychain);
        assert_eq!(status.state, LoginState::LoggedIn);
        assert_eq!(status.plan.as_deref(), Some("Claude Team"));
        assert_eq!(status.auth_kind.as_deref(), Some("oauth"));
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("secret"));
    }

    #[test]
    fn claude_plan_falls_back_to_title_cased_billing_type() {
        assert_eq!(
            claude_plan_label(None, Some("stripe_subscription")).as_deref(),
            Some("Stripe Subscription")
        );
        assert_eq!(
            claude_plan_label(Some("max"), None).as_deref(),
            Some("Claude Max")
        );
        assert_eq!(
            claude_plan_label(Some("some_new_tier"), None).as_deref(),
            Some("Claude Some New Tier")
        );
        assert_eq!(claude_plan_label(None, None), None);
    }

    fn codex_status_for(auth_json: &str) -> LoginAccountStatus {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("auth.json"), auth_json).unwrap();
        codex_status(temp.path(), &NoKeychain)
    }

    #[test]
    fn codex_api_key_only_file_reports_api_key_without_leaking_it() {
        let status = codex_status_for(r#"{"OPENAI_API_KEY":"sk-live-secret"}"#);
        assert_eq!(status.plan.as_deref(), Some("API Key"));
        assert_eq!(status.auth_kind.as_deref(), Some("api_key"));
        assert!(!serde_json::to_string(&status).unwrap().contains("sk-live"));

        let empty = codex_status_for(r#"{"OPENAI_API_KEY":""}"#);
        assert_eq!(empty.plan, None);
        let null = codex_status_for(r#"{"OPENAI_API_KEY":null}"#);
        assert_eq!(null.plan, None);
    }

    #[test]
    fn codex_id_token_reports_chatgpt_plan_claim() {
        let token = jwt(serde_json::json!({
            "email": "c@d.co",
            "https://api.openai.com/auth": {"chatgpt_plan_type": "plus"}
        }));
        let auth = format!(r#"{{"tokens":{{"id_token":"{token}","access_token":"at-secret"}}}}"#);
        let status = codex_status_for(&auth);
        assert_eq!(status.plan.as_deref(), Some("ChatGPT Plus"));
        assert_eq!(status.auth_kind.as_deref(), Some("chatgpt"));
        assert_eq!(status.identity.as_deref(), Some("c@d.co"));
        assert!(!serde_json::to_string(&status)
            .unwrap()
            .contains("at-secret"));
    }

    #[test]
    fn codex_auth_mode_wins() {
        let token = jwt(serde_json::json!({"chatgpt_plan_type": "pro"}));
        let auth = format!(
            r#"{{"auth_mode":"chatgpt","OPENAI_API_KEY":"sk-x","tokens":{{"id_token":"{token}"}}}}"#
        );
        assert_eq!(codex_status_for(&auth).plan.as_deref(), Some("ChatGPT Pro"));
        let api = codex_status_for(r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-x"}"#);
        assert_eq!(api.plan.as_deref(), Some("API Key"));
        assert_eq!(api.auth_kind.as_deref(), Some("api_key"));
    }
}
