use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;

/// 合成「系统环境变量」Provider 的固定 id。
///
/// 这是一个**不落盘**的虚拟条目：选中它表示 CC-Panes 不注入任何 Provider 环境变量，
/// 让子进程继承宿主环境 / 让 CLI 读自己的配置（如 cc-switch 写的 `~/.claude/settings.json`）。
/// 语义上等价于 `LaunchProviderSelection::None`，但以显式 id 的形式在列表里可选/可展示。
pub const SYSTEM_PROVIDER_ID: &str = "__system__";

/// Provider 类型
///
/// `Deserialize` 为手写实现（见下方 `impl Deserialize for ProviderType`）：
/// 历史数据里可能存着已移除的类型（如 "glm"），反序列化时回退到默认值
/// `Anthropic`，而不是让整个 Provider 配置加载失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType {
    #[default]
    Anthropic,
    Bedrock,
    Vertex,
    Proxy,
    ConfigProfile,
    #[serde(rename = "open_ai", alias = "open_a_i")]
    OpenAI,
    Gemini,
    Kimi,
    Cursor,
    #[serde(rename = "opencode", alias = "open_code")]
    OpenCode,
    Grok,
    /// 本机网关（magpie / CC Switch 代理）。这一批只有枚举值与序列化，不做探测。
    LocalGateway,
}

impl ProviderType {
    /// 序列化 id 的逆解析（含历史别名）。未知 id 返回 None。
    pub fn from_id(id: &str) -> Option<Self> {
        Some(match id {
            "anthropic" => ProviderType::Anthropic,
            "bedrock" => ProviderType::Bedrock,
            "vertex" => ProviderType::Vertex,
            "proxy" => ProviderType::Proxy,
            "config_profile" => ProviderType::ConfigProfile,
            "open_ai" | "open_a_i" => ProviderType::OpenAI,
            "gemini" => ProviderType::Gemini,
            "kimi" => ProviderType::Kimi,
            "cursor" => ProviderType::Cursor,
            "opencode" | "open_code" => ProviderType::OpenCode,
            "grok" => ProviderType::Grok,
            "local_gateway" => ProviderType::LocalGateway,
            _ => return None,
        })
    }
}

impl<'de> Deserialize<'de> for ProviderType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let id = String::deserialize(deserializer)?;
        Ok(ProviderType::from_id(&id).unwrap_or(ProviderType::Anthropic))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
    /// 上下文窗口大小，**字符串形式**（`"1m"` / `"200k"` / `"500k"` 等），匹配
    /// Claude Code 的 `ANTHROPIC_MODEL` 后缀约定。managed_settings 注入 `--settings` 时
    /// 会按此值拼 `[<size>]` 后缀到 model id；空 / `"200k"`（默认）/ `"custom"` 不拼。
    /// 与 `context_window_tokens` 互补：前者控制注入时形态，后者控制 context 解析。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_size: Option<String>,
    /// 在下拉中隐藏：启动档 / 启动器的模型下拉不再列出它，但已引用它的启动档仍能解析。
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// 默认账号的固定 id 与名字（旧供应商迁移后落在这个账号上）。
pub const DEFAULT_ACCOUNT_ID: &str = "default";
pub const DEFAULT_ACCOUNT_NAME: &str = "默认";

/// 合成「默认登录」账号的固定 id。
///
/// 机器上原有的那套登录（CLI 的默认目录）不落盘、不建目录：选中它表示「用这条供应商的
/// 接口和环境变量，但登录用 CLI 默认目录里的那一套」——不带目录变量，等同现状。
/// 它只在读取时合成（见 [`Provider::resolve_account`]），`providers.json` 里不会出现。
pub const DEFAULT_LOGIN_ACCOUNT_ID: &str = "__default_login__";
pub const DEFAULT_LOGIN_ACCOUNT_NAME: &str = "默认登录";

/// 支持登录账号的五个 CLI。
pub const LOGIN_CLI_TOOLS: [&str; 5] = ["claude", "codex", "gemini", "antigravity", "grok"];

/// 密钥 / 敏感值存在哪。文件里只留这个标记，不留明文（`File` 回退除外）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SecretStorage {
    /// 没有值。
    #[default]
    None,
    /// 值在系统钥匙串里，文件里没有明文。
    Keychain,
    /// 「未进钥匙串」：当前环境没有可用钥匙串，值仍以明文留在 providers.json。
    File,
}

impl SecretStorage {
    pub fn is_none(&self) -> bool {
        matches!(self, SecretStorage::None)
    }
}

/// 一条自定义环境变量。`sensitive` 的值不落盘（进钥匙串），文件里只留 `storage` 标记。
///
/// `Debug` 是手写的：敏感值只打印「有 / 没有」，不会随日志或断言信息漏出去。
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEnvVar {
    pub name: String,
    /// 非敏感：明文值。敏感：仅作为**写入时的输入**，或在 `storage == File` 回退时落盘。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default)]
    pub sensitive: bool,
    /// 仅敏感条目有意义：值存在哪。
    #[serde(default, skip_serializing_if = "SecretStorage::is_none")]
    pub storage: SecretStorage,
}

impl std::fmt::Debug for ProviderEnvVar {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut debug = f.debug_struct("ProviderEnvVar");
        debug.field("name", &self.name);
        if self.sensitive {
            debug.field("value", &self.value.as_ref().map(|_| "<redacted>"));
        } else {
            debug.field("value", &self.value);
        }
        debug
            .field("sensitive", &self.sensitive)
            .field("storage", &self.storage)
            .finish()
    }
}

/// 接口种类。哪种 CLI 用哪种接口，就取哪个地址。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointKind {
    Anthropic,
    Chat,
    Responses,
    Gemini,
}

/// 一条供应商的多个接口地址（四种，均可缺）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEndpoints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub responses: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini: Option<String>,
}

impl ProviderEndpoints {
    pub fn is_empty(&self) -> bool {
        EndpointKind::ALL
            .iter()
            .all(|kind| self.get(*kind).is_none())
    }

    /// 取某种接口的地址；空白视为未填。
    pub fn get(&self, kind: EndpointKind) -> Option<&str> {
        match kind {
            EndpointKind::Anthropic => self.anthropic.as_deref(),
            EndpointKind::Chat => self.chat.as_deref(),
            EndpointKind::Responses => self.responses.as_deref(),
            EndpointKind::Gemini => self.gemini.as_deref(),
        }
        .map(str::trim)
        .filter(|value| !value.is_empty())
    }

    pub fn set(&mut self, kind: EndpointKind, value: Option<String>) {
        let value = value
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        match kind {
            EndpointKind::Anthropic => self.anthropic = value,
            EndpointKind::Chat => self.chat = value,
            EndpointKind::Responses => self.responses = value,
            EndpointKind::Gemini => self.gemini = value,
        }
    }
}

impl EndpointKind {
    pub const ALL: [EndpointKind; 4] = [
        EndpointKind::Anthropic,
        EndpointKind::Chat,
        EndpointKind::Responses,
        EndpointKind::Gemini,
    ];
}

/// 账号类型：一把密钥，或一套 CLI 自己的登录（对应一个独立目录）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    #[default]
    ApiKey,
    Login,
}

/// 供应商下的账号。账号回答「我是谁」，供应商回答「请求发到哪」；账号不跨供应商复用。
///
/// `Debug` 是手写的：密钥只打印「有 / 没有」。
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccount {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub kind: AccountKind,
    /// 密钥账号：密钥存在哪（`none` = 没有密钥）。这是文件里唯一的「有 / 没有」标记。
    #[serde(default, skip_serializing_if = "SecretStorage::is_none")]
    pub secret_storage: SecretStorage,
    /// 密钥明文。仅作为**写入时的输入**（保存后进钥匙串并清空），
    /// 或在 `secret_storage == File` 回退时落盘。读接口返回给界面前会被清掉。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// 登录账号：这套登录属于哪个 CLI（`claude` / `codex` / `gemini` / `antigravity` / `grok`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_tool: Option<String>,
    /// 登录账号：对应的独立目录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    /// 账号自己的环境变量，覆盖供应商那一组。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<ProviderEnvVar>,
}

impl std::fmt::Debug for ProviderAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderAccount")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("color", &self.color)
            .field("kind", &self.kind)
            .field("secret_storage", &self.secret_storage)
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .field("cli_tool", &self.cli_tool)
            .field("config_dir", &self.config_dir)
            .field("env", &self.env)
            .finish()
    }
}

impl ProviderAccount {
    pub fn default_for(provider_type: ProviderType) -> Self {
        let login = provider_type == ProviderType::ConfigProfile;
        Self {
            id: DEFAULT_ACCOUNT_ID.to_string(),
            name: DEFAULT_ACCOUNT_NAME.to_string(),
            kind: if login {
                AccountKind::Login
            } else {
                AccountKind::ApiKey
            },
            cli_tool: login.then(|| "claude".to_string()),
            ..Self::default()
        }
    }

    /// 合成某个 CLI 的「默认登录」账号（不带目录）。该 CLI 不支持登录账号时返回 `None`。
    pub fn default_login_for(cli_tool: &str) -> Option<Self> {
        login_dir_env_var(cli_tool)?;
        Some(Self {
            id: DEFAULT_LOGIN_ACCOUNT_ID.to_string(),
            name: DEFAULT_LOGIN_ACCOUNT_NAME.to_string(),
            kind: AccountKind::Login,
            cli_tool: Some(cli_tool.to_string()),
            ..Self::default()
        })
    }

    /// 是不是合成的「默认登录」。
    pub fn is_default_login(&self) -> bool {
        self.kind == AccountKind::Login && self.id == DEFAULT_LOGIN_ACCOUNT_ID
    }

    /// 这个账号是否带着一把密钥（在钥匙串、在文件，或刚输入尚未保存）。
    pub fn has_secret(&self) -> bool {
        self.kind == AccountKind::ApiKey
            && (!self.secret_storage.is_none()
                || self
                    .secret
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty()))
    }

    /// 登录账号的目录（空白视为未填）。
    pub fn login_dir(&self) -> Option<&str> {
        if self.kind != AccountKind::Login {
            return None;
        }
        self.config_dir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }
}

/// 登录账号用哪个环境变量把 CLI 指到独立目录。只有这五个 CLI 支持登录账号。
pub fn login_dir_env_var(cli_tool: &str) -> Option<&'static str> {
    Some(match cli_tool {
        "claude" => "CLAUDE_CONFIG_DIR",
        "codex" => "CODEX_HOME",
        "gemini" => "GEMINI_CLI_HOME",
        "antigravity" => "GEMINI_HOME",
        "grok" => "GROK_HOME",
        _ => return None,
    })
}

/// Antigravity 把所有登录放进同一个钥匙串条目、不分目录；只有当它认为自己在远程连接里
/// 才改用目录里的文件存凭据（T3 Code 的做法；agy 1.5.14 日志实测："Using file-based token
/// storage because SSH session detected"）。所以它的登录账号在登录和启动时都带这个变量，
/// 否则换了目录（`--gemini_dir`）也还是同一个号。
pub const ANTIGRAVITY_FILE_STORAGE_ENV: (&str, &str) =
    ("SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 0");

/// Gemini CLI 默认把 OAuth 凭据放在 `<目录>/.gemini/oauth_creds.json`（按目录分开）；
/// 但环境里若有 `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`，它会改用系统钥匙串里
/// 同一个条目（不分目录）。登录账号显式关掉它，保证各账号的凭据互不覆盖。
pub const GEMINI_PER_DIR_STORAGE_ENV: (&str, &str) =
    ("GEMINI_FORCE_ENCRYPTED_FILE_STORAGE", "false");

/// 带目录的登录账号在登录和启动时额外要带的变量：让凭据确实按目录分开存。
pub fn login_isolation_env(cli_tool: &str) -> Option<(&'static str, &'static str)> {
    match cli_tool {
        "antigravity" => Some(ANTIGRAVITY_FILE_STORAGE_ENV),
        "gemini" => Some(GEMINI_PER_DIR_STORAGE_ENV),
        _ => None,
    }
}

/// 供应商来源种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderOriginKind {
    #[default]
    Manual,
    CcSwitch,
    Magpie,
    LocalGateway,
}

/// 供应商来源：从哪来、对方的条目编号、导入时间、当时内容的指纹（供后续「来源更新」比对）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOrigin {
    #[serde(default)]
    pub kind: ProviderOriginKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    /// RFC 3339 时间。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

/// Provider 配置
///
/// 落盘格式（`providers.json` schema v2）里**没有** `apiKey` / `baseUrl` / `configDir`：
/// 密钥在账号上（钥匙串），地址在 `endpoints`，目录在登录账号上。这三个字段保留在结构体里
/// 只做两件事：读旧文件（v1）时承接旧值，以及给旧界面 / 旧客户端当兼容视图——
/// 读出来时 `base_url` / `config_dir` 是默认账号与主接口的镜像，`api_key` 永远为空；
/// 写进来时按「补丁」解释（`None` 不动、空串清除、非空写入默认账号 / 主接口）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub provider_type: ProviderType,
    /// 兼容输入：写入默认账号的密钥。从不落盘，读接口永远返回空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// 兼容视图：主接口地址的镜像（见 [`Provider::primary_endpoint_kind`]）。不落盘。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aws_profile: Option<String>,
    /// 兼容视图：默认账号是登录账号时它的目录镜像。不落盘。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model_id: Option<String>,
    /// Codex 专用：模型供应商的 wire API（"responses" | "chat"），缺省 responses。
    /// 只实现 /chat/completions 的中转需要显式设为 chat（issue #46）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_wire_api: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    /// 多个接口地址：Anthropic / Chat / Responses / Gemini。
    #[serde(default, skip_serializing_if = "ProviderEndpoints::is_empty")]
    pub endpoints: ProviderEndpoints,
    /// 供应商一级的自定义环境变量（叠在按类型自动生成的之上）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<ProviderEnvVar>,
    /// 账号。落盘后至少有一个。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<ProviderAccount>,
    /// 默认账号：运行配置 / 工作空间 / 启动请求没指定账号时用它。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_account_id: Option<String>,
    /// 来源（缺省 = 手动）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ProviderOrigin>,
    /// 原生 CLI 配置覆盖片段：CLI id（`codex` / `claude`）→ 原文（Codex 为 TOML、Claude 为 JSON）。
    /// 保存原文以保留用户格式；合并规则见 `services::native_config`。
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub native_overrides: std::collections::BTreeMap<String, String>,
    /// 只读本地数据的提醒开关。缺省 = 全开；更新时不带它就沿用已存的值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alerts: Option<ProviderAlerts>,
}

/// 供应商级提醒：只看本地会话日志和已有的纯度检测结果，不发请求、不改 CLI 环境。
/// 只对 API key 账号生效；订阅登录账号永远不提醒。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAlerts {
    /// 会话缓存命中率明显偏低时提醒（中转可能没转发缓存，按全价计费）。
    #[serde(default = "default_alert_on")]
    pub cache_low: bool,
    /// 上次纯度检测发现提示词注入时提醒。
    #[serde(default = "default_alert_on")]
    pub injection: bool,
}

fn default_alert_on() -> bool {
    true
}

impl Default for ProviderAlerts {
    fn default() -> Self {
        Self {
            cache_low: true,
            injection: true,
        }
    }
}

impl Provider {
    /// 这个类型的「主接口」：旧 `base_url` 迁移后放进它，兼容视图也镜像它。
    pub fn primary_endpoint_kind(&self) -> EndpointKind {
        match self.provider_type {
            ProviderType::Anthropic
            | ProviderType::Bedrock
            | ProviderType::Vertex
            | ProviderType::Proxy
            | ProviderType::ConfigProfile
            | ProviderType::LocalGateway => EndpointKind::Anthropic,
            ProviderType::OpenAI => {
                if self.codex_wire_is_chat() {
                    EndpointKind::Chat
                } else {
                    EndpointKind::Responses
                }
            }
            ProviderType::Gemini => EndpointKind::Gemini,
            ProviderType::Kimi
            | ProviderType::Cursor
            | ProviderType::OpenCode
            | ProviderType::Grok => EndpointKind::Chat,
        }
    }

    fn codex_wire_is_chat(&self) -> bool {
        self.codex_wire_api
            .as_deref()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("chat"))
    }

    /// 兼容视图 `base_url` 镜像哪个接口：主接口；Chat 与 Responses 同属 OpenAI 系，
    /// 主接口没填时镜像另一个（旧界面改 wire API 不会让地址「消失」）。
    pub fn mirrored_endpoint_kind(&self) -> EndpointKind {
        let primary = self.primary_endpoint_kind();
        Self::with_openai_fallback(primary)
            .into_iter()
            .find(|kind| self.endpoints.get(*kind).is_some())
            .unwrap_or(primary)
    }

    fn with_openai_fallback(kind: EndpointKind) -> Vec<EndpointKind> {
        match kind {
            EndpointKind::Chat => vec![EndpointKind::Chat, EndpointKind::Responses],
            EndpointKind::Responses => vec![EndpointKind::Responses, EndpointKind::Chat],
            other => vec![other],
        }
    }

    /// 某个 CLI 依次尝试哪些接口（第一个填了的生效）。
    ///
    /// 规则：Claude / jcode 只认 Anthropic；Gemini / Antigravity 只认 Gemini；
    /// Codex 认 Responses（`codex_wire_api = chat` 时先认 Chat）；Kimi / Grok 认 Chat；
    /// OpenCode / Pi / Oh My Pi 是多协议客户端，跟随供应商类型的主接口。
    /// Chat 与 Responses 互为回退（同一个 OpenAI 兼容地址通常两者都能用），
    /// Anthropic 与 Gemini 不回退：没填就不注入地址，CLI 用它自己的默认地址。
    pub fn endpoint_kinds_for_cli(&self, cli_tool: &str) -> Vec<EndpointKind> {
        match cli_tool {
            "claude" | "jcode" => vec![EndpointKind::Anthropic],
            "gemini" | "antigravity" => vec![EndpointKind::Gemini],
            "codex" => Self::with_openai_fallback(if self.codex_wire_is_chat() {
                EndpointKind::Chat
            } else {
                EndpointKind::Responses
            }),
            "kimi" | "grok" => Self::with_openai_fallback(EndpointKind::Chat),
            "cursor" | "none" => Vec::new(),
            _ => Self::with_openai_fallback(match self.primary_endpoint_kind() {
                EndpointKind::Responses => EndpointKind::Chat,
                other => other,
            }),
        }
    }

    /// 某个 CLI 实际用的接口地址；没填对应接口时返回 `None`（不注入地址）。
    pub fn endpoint_for_cli(&self, cli_tool: &str) -> Option<(EndpointKind, &str)> {
        self.endpoint_kinds_for_cli(cli_tool)
            .into_iter()
            .find_map(|kind| self.endpoints.get(kind).map(|url| (kind, url)))
    }

    /// Codex 实际用的 wire API：显式配置优先；没配时跟随取到的接口
    /// （只填了 Chat 接口 → `chat`）。`None` = 缺省 responses。
    pub fn effective_codex_wire_api(&self) -> Option<String> {
        if let Some(explicit) = self
            .codex_wire_api
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(explicit.to_string());
        }
        match self.endpoint_for_cli("codex") {
            Some((EndpointKind::Chat, _)) => Some("chat".to_string()),
            _ => None,
        }
    }

    /// 默认账号；`default_account_id` 失效时退回第一个账号。
    pub fn default_account(&self) -> Option<&ProviderAccount> {
        self.default_account_id
            .as_deref()
            .and_then(|id| self.accounts.iter().find(|account| account.id == id))
            .or_else(|| self.accounts.first())
    }

    /// 取指定账号；不指定（或空白）时用默认账号。指定了但不存在返回 `None`。
    pub fn account(&self, account_id: Option<&str>) -> Option<&ProviderAccount> {
        match account_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => self.accounts.iter().find(|account| account.id == id),
            None => self.default_account(),
        }
    }

    /// 取账号，认得合成的「默认登录」：`account_id` 是 [`DEFAULT_LOGIN_ACCOUNT_ID`] 时
    /// 按目标 CLI 合成一个不带目录的登录账号（该 CLI 不能在这条供应商下登录时返回 `None`）。
    /// 其余情况同 [`Provider::account`]。
    pub fn resolve_account(
        &self,
        account_id: Option<&str>,
        cli_tool: &str,
    ) -> Option<Cow<'_, ProviderAccount>> {
        if account_id.map(str::trim) == Some(DEFAULT_LOGIN_ACCOUNT_ID) {
            return self
                .login_cli_tools()
                .contains(&cli_tool)
                .then(|| ProviderAccount::default_login_for(cli_tool))
                .flatten()
                .map(Cow::Owned);
        }
        self.account(account_id).map(Cow::Borrowed)
    }

    /// 这条供应商下可以挂哪些 CLI 的登录账号（按供应商类型）。
    ///
    /// 与各适配器的兼容类型一致（Gemini 类型下 Gemini CLI 与 Antigravity 都能挂）。
    /// 「配置目录」类型本身就是一个目录，不再合成默认登录；「本机网关」还没有任何适配器接。
    pub fn login_cli_tools(&self) -> &'static [&'static str] {
        match self.provider_type {
            ProviderType::Anthropic
            | ProviderType::Bedrock
            | ProviderType::Vertex
            | ProviderType::Proxy => &["claude"],
            ProviderType::OpenAI => &["codex"],
            ProviderType::Gemini => &["gemini", "antigravity"],
            ProviderType::Grok => &["grok"],
            ProviderType::ConfigProfile
            | ProviderType::LocalGateway
            | ProviderType::Kimi
            | ProviderType::Cursor
            | ProviderType::OpenCode => &[],
        }
    }

    /// 给界面 / REST 的只读副本：清掉一切密钥与敏感值明文（含 `File` 回退时文件里的那份），
    /// 只留「有 / 没有、存在哪」的标记。
    pub fn redacted(mut self) -> Self {
        fn redact_env(entries: &mut [ProviderEnvVar]) {
            for entry in entries.iter_mut().filter(|entry| entry.sensitive) {
                // 明文还在文件里（回退，或迁移尚未成功）：对外如实标成「未进钥匙串」。
                if entry.value.take().is_some() && entry.storage.is_none() {
                    entry.storage = SecretStorage::File;
                }
            }
        }
        self.api_key = None;
        redact_env(&mut self.env);
        for account in &mut self.accounts {
            if account.secret.take().is_some() && account.secret_storage.is_none() {
                account.secret_storage = SecretStorage::File;
            }
            redact_env(&mut account.env);
        }
        self
    }

    /// 按类型（必要时按目标 CLI）自动生成的环境变量：(名字, 值, 是否敏感)。
    ///
    /// `api_key` 是调用方已解析出的密钥明文；登录账号必须传 `None`——
    /// 登录账号只带该 CLI 的目录变量，不带密钥。
    pub fn generated_env(
        &self,
        cli_tool: &str,
        account: &ProviderAccount,
        api_key: Option<&str>,
    ) -> Vec<(String, String, bool)> {
        let mut vars: Vec<(String, String, bool)> = Vec::new();
        let key = if account.kind == AccountKind::Login {
            None
        } else {
            api_key.map(str::trim).filter(|value| !value.is_empty())
        };
        let url = self.endpoint_for_cli(cli_tool).map(|(_, url)| url);
        let push_key = |vars: &mut Vec<(String, String, bool)>, name: &str| {
            if let Some(key) = key {
                vars.push((name.to_string(), key.to_string(), true));
            }
        };
        let push = |vars: &mut Vec<(String, String, bool)>, name: &str, value: Option<&str>| {
            if let Some(value) = value {
                vars.push((name.to_string(), value.to_string(), false));
            }
        };

        // 本机网关按目标 CLI 的原生协议生成；其余类型按自身类型生成。
        let effective = match self.provider_type {
            ProviderType::LocalGateway => match cli_tool {
                "codex" => ProviderType::OpenAI,
                "gemini" | "antigravity" => ProviderType::Gemini,
                _ => ProviderType::Anthropic,
            },
            other => other,
        };
        match effective {
            ProviderType::Anthropic | ProviderType::Proxy => {
                push_key(&mut vars, "ANTHROPIC_API_KEY");
                push(&mut vars, "ANTHROPIC_BASE_URL", url);
            }
            ProviderType::Bedrock => {
                push(&mut vars, "CLAUDE_CODE_USE_BEDROCK", Some("1"));
                push(&mut vars, "AWS_REGION", self.region.as_deref());
                push(&mut vars, "AWS_PROFILE", self.aws_profile.as_deref());
            }
            ProviderType::Vertex => {
                push(&mut vars, "CLAUDE_CODE_USE_VERTEX", Some("1"));
                push(&mut vars, "CLOUD_ML_REGION", self.region.as_deref());
                push(
                    &mut vars,
                    "ANTHROPIC_VERTEX_PROJECT_ID",
                    self.project_id.as_deref(),
                );
            }
            ProviderType::ConfigProfile | ProviderType::LocalGateway => {}
            ProviderType::OpenAI => {
                push_key(&mut vars, "CODEX_API_KEY");
                push(&mut vars, "OPENAI_BASE_URL", url);
            }
            ProviderType::Gemini => {
                push_key(&mut vars, "GEMINI_API_KEY");
                // Antigravity 读 `GOOGLE_GEMINI_BASE_URL`（agy CHANGELOG：Gemini API 直连时
                // "point `GOOGLE_GEMINI_BASE_URL` at a custom endpoint"）。
                let base_url_var = if cli_tool == "antigravity" {
                    "GOOGLE_GEMINI_BASE_URL"
                } else {
                    "GEMINI_API_BASE"
                };
                push(&mut vars, base_url_var, url);
            }
            ProviderType::Kimi => {
                push_key(&mut vars, "KIMI_API_KEY");
                push(&mut vars, "KIMI_BASE_URL", url);
            }
            ProviderType::Cursor => {
                push_key(&mut vars, "CURSOR_API_KEY");
            }
            ProviderType::OpenCode => {
                // OpenCode uses standard OpenAI-compatible variables
                push_key(&mut vars, "OPENAI_API_KEY");
                push(&mut vars, "OPENAI_BASE_URL", url);
            }
            ProviderType::Grok => {
                push_key(&mut vars, "XAI_API_KEY");
                push(&mut vars, "GROK_MODELS_BASE_URL", url);
                push(&mut vars, "GROK_CLI_CHAT_PROXY_BASE_URL", url);
            }
        }

        // 登录账号：把该 CLI 指到账号自己的目录。账号属于别的 CLI 时不带（目录对不上）。
        if let Some(dir) = account.login_dir() {
            if account.cli_tool.as_deref() == Some(cli_tool) {
                if let Some(name) = login_dir_env_var(cli_tool) {
                    vars.push((name.to_string(), dir.to_string(), false));
                }
                if let Some((name, value)) = login_isolation_env(cli_tool) {
                    vars.push((name.to_string(), value.to_string(), false));
                }
            }
        }
        vars
    }
}

/// `providers.json` 当前的文件格式版本。
///
/// - 缺省 / 1：旧格式，供应商上直接放 `apiKey` / `baseUrl` / `configDir`。
/// - 2：账号 + 多接口 + 自定义环境变量；密钥不落盘（见 `ProviderAccount::secret_storage`）。
pub const PROVIDER_SCHEMA_VERSION: u32 = 2;

/// Provider 配置文件
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderConfig {
    /// 文件格式版本，见 [`PROVIDER_SCHEMA_VERSION`]。旧文件没有这个字段（= 1）。
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub providers: Vec<Provider>,
    /// 每个 CLI 工具各自的默认 Provider id。
    ///
    /// 值也可以是 `SYSTEM_PROVIDER_ID`，表示该 CLI 跟随自身/系统配置，不注入托管凭证。
    #[serde(default)]
    pub default_provider_ids: HashMap<String, String>,
    /// 默认 Provider 映射的数据语义版本。
    ///
    /// v1 及更早版本会把一个 Provider 扇出为所有 CLI 的默认值；v2 起只为
    /// Provider 的原生 CLI 自动建立默认值，跨 CLI 默认必须由用户显式选择。
    #[serde(default)]
    pub default_provider_ids_version: u8,
    /// 「系统环境变量」（`SYSTEM_PROVIDER_ID`）被显式设为默认。
    ///
    /// 该伪条目不落入 `providers`，故无法用 `is_default` 表达；用这个独立标记持久化。
    /// 与任一 provider 的 `is_default` 互斥：设置其一即清空另一方。
    #[serde(default)]
    pub default_is_system: bool,
}

/// 「系统环境变量」条目的探测结果。
///
/// `active` 与旧版 `detect_system_provider` 的布尔返回值语义一致；其余字段供 UI 展示
/// 「探测到了什么」以及「用户是否已把系统条目设为默认」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProviderInfo {
    /// 探测到 cc-switch 或宿主 Anthropic 凭证之一。
    pub active: bool,
    /// 探测到 `~/.cc-switch/cc-switch.db`。
    pub cc_switch: bool,
    /// 宿主进程中命中的 Anthropic 环境变量名（**只有键名，不含值**）。
    pub env_keys: Vec<String>,
    /// 用户已把「系统环境变量」设为默认凭证（持久化状态）。
    pub default_is_system: bool,
    /// 每个 CLI 工具对应的持久化默认 Provider id。
    #[serde(default)]
    pub default_provider_ids: HashMap<String, String>,
}

#[cfg(test)]
mod tests {
    use super::{Provider, ProviderType};
    use serde_json::json;

    /// 已移除的 Provider 类型（如 glm）反序列化时必须回退默认值，
    /// 不能让老 Provider 配置整条加载失败。
    #[test]
    fn deserialization_falls_back_to_anthropic_for_removed_types() {
        assert_eq!(
            serde_json::from_str::<ProviderType>("\"glm\"").ok(),
            Some(ProviderType::Anthropic)
        );
    }

    #[test]
    fn provider_models_round_trip_and_preserve_default() {
        let input = json!({
            "id": "provider-1",
            "name": "Provider 1",
            "providerType": "open_ai",
            "models": [
                { "id": "gpt-5.4", "label": "GPT 5.4", "defaultEffort": "high", "contextWindowTokens": 353000 },
                { "id": "gpt-5.4-mini", "label": "GPT 5.4 Mini" }
            ],
            "defaultModelId": "gpt-5.4-mini",
            "isDefault": false
        });
        let provider: Provider = serde_json::from_value(input.clone())
            .expect("provider model catalog should deserialize");

        let value = serde_json::to_value(provider).expect("provider should serialize");

        assert_eq!(value, input);
    }

    #[test]
    fn provider_model_hidden_defaults_false_and_is_skipped_when_false() {
        let model: super::ProviderModel =
            serde_json::from_value(json!({ "id": "m" })).expect("legacy model");
        assert!(!model.hidden);
        assert!(serde_json::to_value(&model)
            .unwrap()
            .get("hidden")
            .is_none());

        let hidden: super::ProviderModel =
            serde_json::from_value(json!({ "id": "m", "hidden": true })).expect("hidden model");
        assert!(hidden.hidden);
        assert_eq!(
            serde_json::to_value(&hidden).unwrap()["hidden"],
            json!(true)
        );
    }

    #[test]
    fn legacy_provider_without_model_fields_uses_empty_catalog() {
        let provider: Provider = serde_json::from_value(json!({
            "id": "legacy-provider",
            "name": "Legacy Provider",
            "providerType": "anthropic",
            "isDefault": false
        }))
        .expect("legacy provider should deserialize");

        assert!(provider.models.is_empty());
        assert!(provider.default_model_id.is_none());
    }

    #[test]
    fn provider_model_context_window_rejects_invalid_json_number_types() {
        for invalid_window in [json!(-1), json!(1_000.5), json!("1000")] {
            let result = serde_json::from_value::<Provider>(json!({
                "id": "provider-invalid-window",
                "name": "Provider Invalid Window",
                "providerType": "anthropic",
                "models": [{
                    "id": "model-a",
                    "contextWindowTokens": invalid_window
                }],
                "isDefault": false
            }));

            assert!(result.is_err());
        }

        let provider: Provider = serde_json::from_value(json!({
            "id": "provider-null-window",
            "name": "Provider Null Window",
            "providerType": "anthropic",
            "models": [{
                "id": "model-a",
                "contextWindowTokens": null
            }],
            "isDefault": false
        }))
        .expect("null context window should mean unknown");

        assert!(provider.models[0].context_window_tokens.is_none());
    }

    #[test]
    fn open_ai_uses_canonical_name_and_accepts_legacy_name() {
        assert_eq!(
            serde_json::from_str::<ProviderType>(r#""open_ai""#).unwrap(),
            ProviderType::OpenAI
        );
        assert_eq!(
            serde_json::from_str::<ProviderType>(r#""open_a_i""#).unwrap(),
            ProviderType::OpenAI
        );
        assert_eq!(
            serde_json::to_string(&ProviderType::OpenAI).unwrap(),
            r#""open_ai""#
        );
    }
}
