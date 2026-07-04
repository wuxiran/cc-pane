use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const DEFAULT_TERMINAL_FONT_SIZE: u16 = 15;
const MIN_TERMINAL_FONT_SIZE: u16 = 10;
const MAX_TERMINAL_FONT_SIZE: u16 = 32;
const DEFAULT_WEB_ACCESS_PORT: u16 = 18080;
const WEB_PASSWORD_HASH_ITERATIONS: usize = 120_000;

/// 应用设置
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub proxy: ProxySettings,
    #[serde(default)]
    pub theme: ThemeSettings,
    #[serde(default)]
    pub terminal: TerminalSettings,
    #[serde(default)]
    pub shortcuts: ShortcutSettings,
    #[serde(default)]
    pub general: GeneralSettings,
    #[serde(default)]
    pub notification: NotificationSettings,
    #[serde(default)]
    pub screenshot: ScreenshotSettings,
    #[serde(default)]
    pub voice: VoiceSettings,
    #[serde(default)]
    pub ccchan: CCChanSettings,
    #[serde(default)]
    pub cli_launchers: CliLauncherSettings,
    #[serde(default)]
    pub layout_switcher: LayoutSwitcherSettings,
    #[serde(default)]
    pub web_access: WebAccessSettings,
    #[serde(default)]
    pub orchestrator: OrchestratorSettings,
}

impl AppSettings {
    pub fn merge_missing_defaults(&mut self) {
        self.terminal.merge_missing_defaults();
        self.shortcuts.merge_missing_defaults();
        self.voice.merge_missing_defaults();
        self.ccchan.merge_missing_defaults();
        self.cli_launchers.merge_missing_defaults();
        self.web_access.merge_missing_defaults();
        self.orchestrator.merge_missing_defaults();
    }
}

/// Orchestrator（HTTP+MCP server）网络绑定设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSettings {
    /// "auto"：默认只绑回环，检测到 WSL 使用信号时绑全网卡（WSL 内 CLI 需回连宿主）
    /// "loopback"：始终 127.0.0.1；"all"：始终 0.0.0.0
    #[serde(default = "default_orchestrator_bind_mode")]
    pub bind_mode: String,
}

impl Default for OrchestratorSettings {
    fn default() -> Self {
        Self {
            bind_mode: default_orchestrator_bind_mode(),
        }
    }
}

impl OrchestratorSettings {
    pub fn merge_missing_defaults(&mut self) {
        if !matches!(self.bind_mode.as_str(), "auto" | "loopback" | "all") {
            self.bind_mode = default_orchestrator_bind_mode();
        }
    }
}

fn default_orchestrator_bind_mode() -> String {
    "auto".to_string()
}

/// 代理设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub enabled: bool,
    pub proxy_type: String, // "http" | "socks5"
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub no_proxy: Option<String>,
}

/// 主题设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSettings {
    pub mode: String, // "light" | "dark" | "system"
}

/// 终端设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    pub font_size: u16,
    pub font_family: String,
    pub cursor_style: String, // "block" | "underline" | "bar"
    pub cursor_blink: bool,
    pub scrollback: u32,
    /// 终端主题: "followApp" | "dark" | "light"
    #[serde(default = "default_terminal_theme_mode")]
    pub theme_mode: String,
    /// 终端渲染器: "auto" | "webgl" | "dom"
    #[serde(default = "default_terminal_renderer_mode")]
    pub renderer_mode: String,
    /// 用户选择的 Shell ID（如 "pwsh", "cmd", "git-bash"），None 表示自动探测
    #[serde(default)]
    pub shell: Option<String>,
    /// 禁用 ConPTY 输出 sanitize（默认 true，即禁用 sanitize，因为 dwFlags=0 已解决根本问题）
    #[serde(default)]
    pub disable_conpty_sanitize: Option<bool>,
    /// 启用旧版 resume id backfill（扫目录按 mtime 猜测，已被确定性绑定取代）。
    /// 默认 false；仅排障时打开。过渡一两个版本后整套 backfill 将移除。
    #[serde(default)]
    pub resume_id_backfill_enabled: Option<bool>,
}

impl TerminalSettings {
    pub fn merge_missing_defaults(&mut self) {
        if self.scrollback == crate::constants::terminal::LEGACY_DEFAULT_SCROLLBACK {
            self.scrollback = crate::constants::terminal::DEFAULT_SCROLLBACK;
        }
        if self.font_size < MIN_TERMINAL_FONT_SIZE || self.font_size > MAX_TERMINAL_FONT_SIZE {
            self.font_size = DEFAULT_TERMINAL_FONT_SIZE;
        }
        if !matches!(self.theme_mode.as_str(), "followApp" | "dark" | "light") {
            self.theme_mode = default_terminal_theme_mode();
        }
        if !matches!(self.renderer_mode.as_str(), "auto" | "webgl" | "dom") {
            self.renderer_mode = default_terminal_renderer_mode();
        }
    }
}

fn default_terminal_theme_mode() -> String {
    "followApp".to_string()
}

fn default_terminal_renderer_mode() -> String {
    "auto".to_string()
}

/// 快捷键设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    pub bindings: HashMap<String, String>, // actionId -> keyCombo
}

impl ShortcutSettings {
    pub fn merge_missing_defaults(&mut self) {
        let defaults = Self::default();
        for (action_id, key_combo) in defaults.bindings {
            if self.bindings.contains_key(&action_id) {
                continue;
            }
            if self.bindings.values().any(|value| value == &key_combo) {
                continue;
            }
            self.bindings.insert(action_id, key_combo);
        }
    }
}

/// 通知设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub enabled: bool,
    pub on_exit: bool,
    pub on_waiting_input: bool,
    pub only_when_unfocused: bool,
}

/// 搜索范围
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub enum SearchScope {
    #[default]
    Workspace,
    FullDisk,
}

/// 通用设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    #[serde(default = "default_close_to_tray")]
    pub close_to_tray: bool,
    pub auto_start: bool,
    pub language: String,
    #[serde(default)]
    pub data_dir: Option<String>,
    #[serde(default)]
    pub search_scope: SearchScope,
    /// 日志级别: "error" | "warn" | "info" | "debug" | "trace"
    #[serde(default = "default_log_level")]
    pub log_level: String,
    /// 新手引导是否已完成
    #[serde(default)]
    pub onboarding_completed: bool,
    /// 默认 CLI 工具（用于自我对话等场景）: "claude" | "codex"
    #[serde(default = "default_cli_tool")]
    pub default_cli_tool: String,
    /// 页面顶部显示的常用启动项
    #[serde(default = "default_launch_favorites")]
    pub launch_favorites: Vec<String>,
    /// 工作空间右键菜单中隐藏非常用启动项
    #[serde(default)]
    pub hide_non_favorite_launch_actions: bool,
}

fn default_cli_tool() -> String {
    "claude".to_string()
}

fn default_close_to_tray() -> bool {
    !cfg!(target_os = "linux")
}

fn default_launch_favorites() -> Vec<String> {
    // 与前端 launchMenu.ts getDefaultSidebarFavoriteLaunchActionIds() 对齐。
    // 旧值 claude-local/codex-local 仅由前端 normalizeSidebarFavoriteLaunchActionIds()
    // 作为 legacy 兜底迁移，不再作为后端默认。
    vec![
        "terminal-default".to_string(),
        "claude-default".to_string(),
        "codex-default".to_string(),
    ]
}

fn default_log_level() -> String {
    "info".to_string()
}

/// 截图设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotSettings {
    pub shortcut: String,
    pub retention_days: u32,
}

/// 语音输入设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    #[serde(default = "default_voice_provider")]
    pub provider: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub dashscope_api_key: String,
    /// Qwen-ASR OpenAI 兼容 API 地域: "cn" | "intl"
    #[serde(default = "default_voice_region")]
    pub region: String,
    #[serde(default = "default_voice_model")]
    pub model: String,
    #[serde(default)]
    pub mimo_api_key: String,
    #[serde(default = "default_voice_mimo_base_url")]
    pub mimo_base_url: String,
    #[serde(default = "default_voice_mimo_model")]
    pub mimo_model: String,
    /// 可选语种；为空时交给模型自动识别
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub enable_itn: bool,
    #[serde(default = "default_voice_max_record_seconds")]
    pub max_record_seconds: u32,
}

impl VoiceSettings {
    pub fn merge_missing_defaults(&mut self) {
        if !matches!(self.provider.as_str(), "dashscope" | "mimo") {
            self.provider = default_voice_provider();
        }
        if !matches!(self.region.as_str(), "cn" | "intl") {
            self.region = default_voice_region();
        }
        if self.model.trim().is_empty() {
            self.model = default_voice_model();
        }
        if self.mimo_base_url.trim().is_empty() {
            self.mimo_base_url = default_voice_mimo_base_url();
        } else {
            self.mimo_base_url = self.mimo_base_url.trim().trim_end_matches('/').to_string();
        }
        if self.mimo_model.trim().is_empty() {
            self.mimo_model = default_voice_mimo_model();
        }
        if let Some(language) = self.language.as_ref() {
            if language.trim().is_empty() {
                self.language = None;
            }
        }
        if !(1..=300).contains(&self.max_record_seconds) {
            self.max_record_seconds = default_voice_max_record_seconds();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CCChanSettings {
    #[serde(default = "default_ccchan_ai_engine")]
    pub ai_engine: String,
    #[serde(default = "default_ccchan_pet_id")]
    pub default_pet_id: String,
    // 宠物模块默认不打开：开机自动显示与浮窗可见均默认 false（bool 的 serde
    // 默认即 false）。老用户已持久化的设置不受影响，仅全新安装默认隐藏。
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_true")]
    pub sound_enabled: bool,
    #[serde(default)]
    pub window_visible: bool,
    #[serde(default)]
    pub window_x: Option<f64>,
    #[serde(default)]
    pub window_y: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLauncherSettings {
    #[serde(default)]
    pub overrides: HashMap<String, CliLauncherOverride>,
}

impl CliLauncherSettings {
    pub fn command_for(&self, cli_tool_id: &str) -> Option<&str> {
        self.overrides
            .get(cli_tool_id)
            .and_then(|override_value| override_value.command())
    }

    pub fn merge_missing_defaults(&mut self) {
        self.overrides = self
            .overrides
            .drain()
            .filter_map(|(cli_tool_id, mut override_value)| {
                let cli_tool_id = cli_tool_id.trim().to_string();
                if cli_tool_id.is_empty() {
                    return None;
                }
                override_value.command = override_value.command.trim().to_string();
                if override_value.command.is_empty() {
                    None
                } else {
                    Some((cli_tool_id, override_value))
                }
            })
            .collect();
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLauncherOverride {
    #[serde(default)]
    pub command: String,
}

impl CliLauncherOverride {
    pub fn command(&self) -> Option<&str> {
        let command = self.command.trim();
        (!command.is_empty()).then_some(command)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSwitcherSettings {
    #[serde(default)]
    pub window_x: Option<f64>,
    #[serde(default)]
    pub window_y: Option<f64>,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebAccessSettings {
    /// 桌面端启动时是否自动启动 Web UI 服务。
    #[serde(default = "default_web_access_enabled")]
    pub enabled: bool,
    /// 启动 Web UI 服务后是否自动打开浏览器。
    #[serde(default)]
    pub auto_open: bool,
    #[serde(default = "default_web_access_port")]
    pub port: u16,
    /// 是否允许局域网访问。关闭时只监听 127.0.0.1。
    #[serde(default)]
    pub allow_lan: bool,
    /// 精确 IP 白名单；为空表示允许同网段客户端访问。
    #[serde(default)]
    pub ip_whitelist: Vec<String>,
    /// 启用账号密码登录。若未配置密码，运行时会降级为仅本机访问。
    #[serde(default)]
    pub auth_enabled: bool,
    #[serde(default = "default_web_access_username")]
    pub username: String,
    #[serde(default)]
    pub password_salt: Option<String>,
    #[serde(default)]
    pub password_hash: Option<String>,
    /// Web 端空闲自动锁屏分钟数；0 表示不自动锁屏。
    #[serde(default = "default_web_lock_on_idle_minutes")]
    pub lock_on_idle_minutes: u16,
    /// 远程只读模式：非回环来源（含 Tailscale Serve 等本机反向代理转发的远程流量）
    /// 的已登录会话仅允许只读操作；回环来源（本机浏览器）始终全权。
    #[serde(default)]
    pub remote_read_only: bool,
}

impl WebAccessSettings {
    pub fn merge_missing_defaults(&mut self) {
        if !(1..=65535).contains(&self.port) {
            self.port = default_web_access_port();
        }
        if self.username.trim().is_empty() {
            self.username = default_web_access_username();
        } else {
            self.username = self.username.trim().to_string();
        }
        self.ip_whitelist = self
            .ip_whitelist
            .iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();
        if self.lock_on_idle_minutes > 24 * 60 {
            self.lock_on_idle_minutes = default_web_lock_on_idle_minutes();
        }
        if self.password_hash.as_deref().is_some_and(str::is_empty) {
            self.password_hash = None;
        }
        if self.password_salt.as_deref().is_some_and(str::is_empty) {
            self.password_salt = None;
        }
    }

    pub fn password_configured(&self) -> bool {
        self.password_hash.is_some() && self.password_salt.is_some()
    }

    pub fn auth_required(&self) -> bool {
        self.auth_enabled && self.password_configured()
    }

    pub fn set_password(&mut self, password: &str) -> anyhow::Result<()> {
        let trimmed = password.trim();
        if trimmed.is_empty() {
            self.password_salt = None;
            self.password_hash = None;
            return Ok(());
        }
        let salt = generate_salt_hex();
        let hash = hash_web_password(trimmed, &salt)?;
        self.password_salt = Some(salt);
        self.password_hash = Some(hash);
        Ok(())
    }

    pub fn verify_password(&self, password: &str) -> bool {
        let Some(salt) = self.password_salt.as_deref() else {
            return false;
        };
        let Some(expected) = self.password_hash.as_deref() else {
            return false;
        };
        let Ok(actual) = hash_web_password(password, salt) else {
            return false;
        };
        constant_time_eq(actual.as_bytes(), expected.as_bytes())
    }
}

impl CCChanSettings {
    pub fn merge_missing_defaults(&mut self) {
        if !matches!(self.ai_engine.as_str(), "claude" | "codex") {
            self.ai_engine = default_ccchan_ai_engine();
        }
        if self.default_pet_id.trim().is_empty() {
            self.default_pet_id = default_ccchan_pet_id();
        }
    }
}

fn default_ccchan_ai_engine() -> String {
    "claude".to_string()
}

fn default_ccchan_pet_id() -> String {
    "doro.codex-pet".to_string()
}

fn default_true() -> bool {
    true
}

fn default_voice_provider() -> String {
    "dashscope".to_string()
}

fn default_voice_region() -> String {
    "cn".to_string()
}

fn default_voice_model() -> String {
    "qwen3-asr-flash".to_string()
}

fn default_voice_mimo_base_url() -> String {
    "https://api.xiaomimimo.com/v1".to_string()
}

fn default_voice_mimo_model() -> String {
    "mimo-v2.5".to_string()
}

fn default_voice_max_record_seconds() -> u32 {
    60
}

fn default_web_access_enabled() -> bool {
    true
}

fn default_web_access_port() -> u16 {
    DEFAULT_WEB_ACCESS_PORT
}

fn default_web_access_username() -> String {
    "admin".to_string()
}

fn default_web_lock_on_idle_minutes() -> u16 {
    30
}

fn generate_salt_hex() -> String {
    use rand::{rngs::OsRng, RngCore};

    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes_to_hex(&bytes)
}

fn hash_web_password(password: &str, salt_hex: &str) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};

    let salt = hex_to_bytes(salt_hex)?;
    let mut digest = Vec::with_capacity(password.len() + salt.len());
    digest.extend_from_slice(password.as_bytes());
    digest.extend_from_slice(&salt);

    for _ in 0..WEB_PASSWORD_HASH_ITERATIONS {
        let mut hasher = Sha256::new();
        hasher.update(&digest);
        hasher.update(&salt);
        digest = hasher.finalize().to_vec();
    }

    Ok(format!(
        "sha256:{}:{}",
        WEB_PASSWORD_HASH_ITERATIONS,
        bytes_to_hex(&digest)
    ))
}

fn hex_to_bytes(value: &str) -> anyhow::Result<Vec<u8>> {
    let value = value.trim();
    if !value.len().is_multiple_of(2) {
        anyhow::bail!("invalid hex length");
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for chunk in value.as_bytes().chunks(2) {
        let hex = std::str::from_utf8(chunk)?;
        bytes.push(u8::from_str_radix(hex, 16)?);
    }
    Ok(bytes)
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let diff = left
        .iter()
        .zip(right.iter())
        .fold(0_u8, |acc, (left, right)| acc | (left ^ right));
    diff == 0
}

// ---- 默认值实现 ----

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            proxy_type: "http".to_string(),
            host: String::new(),
            port: 7890,
            username: None,
            password: None,
            no_proxy: Some("localhost,127.0.0.1".to_string()),
        }
    }
}

impl Default for ThemeSettings {
    fn default() -> Self {
        Self {
            mode: "dark".to_string(),
        }
    }
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_size: DEFAULT_TERMINAL_FONT_SIZE,
            font_family: "Consolas, \"Courier New\", monospace".to_string(),
            cursor_style: "block".to_string(),
            cursor_blink: false,
            scrollback: crate::constants::terminal::DEFAULT_SCROLLBACK,
            theme_mode: default_terminal_theme_mode(),
            renderer_mode: default_terminal_renderer_mode(),
            shell: None,
            disable_conpty_sanitize: None,
            resume_id_backfill_enabled: None,
        }
    }
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        let mut bindings = HashMap::new();
        bindings.insert("toggle-sidebar".to_string(), "Ctrl+B".to_string());
        bindings.insert("toggle-fullscreen".to_string(), "F11".to_string());
        bindings.insert("new-tab".to_string(), "Ctrl+T".to_string());
        bindings.insert("close-tab".to_string(), "Ctrl+W".to_string());
        bindings.insert("settings".to_string(), "Ctrl+,".to_string());
        bindings.insert("toggle-layouts".to_string(), "Ctrl+Alt+L".to_string());
        bindings.insert("split-right".to_string(), "Ctrl+\\".to_string());
        bindings.insert("split-down".to_string(), "Ctrl+-".to_string());
        bindings.insert("focus-pane-left".to_string(), "Alt+Left".to_string());
        bindings.insert("focus-pane-right".to_string(), "Alt+Right".to_string());
        bindings.insert("focus-pane-up".to_string(), "Alt+Up".to_string());
        bindings.insert("focus-pane-down".to_string(), "Alt+Down".to_string());
        bindings.insert("next-tab".to_string(), "Ctrl+Tab".to_string());
        bindings.insert("prev-tab".to_string(), "Ctrl+Shift+Tab".to_string());
        bindings.insert("toggle-mini-mode".to_string(), "Ctrl+M".to_string());
        bindings.insert("voice-input".to_string(), "Ctrl+Alt+M".to_string());
        for i in 1..=9 {
            bindings.insert(format!("switch-tab-{}", i), format!("Ctrl+{}", i));
        }
        for i in 1..=9 {
            bindings.insert(format!("switch-layout-{}", i), format!("Alt+{}", i));
        }
        Self { bindings }
    }
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            on_exit: true,
            on_waiting_input: true,
            only_when_unfocused: true,
        }
    }
}

impl Default for ScreenshotSettings {
    fn default() -> Self {
        Self {
            shortcut: if cfg!(debug_assertions) {
                "Ctrl+Alt+Shift+S".to_string() // dev 用不同的默认快捷键，避免与 release 冲突
            } else {
                "Ctrl+Shift+S".to_string()
            },
            retention_days: 7,
        }
    }
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            provider: default_voice_provider(),
            enabled: false,
            dashscope_api_key: String::new(),
            region: default_voice_region(),
            model: default_voice_model(),
            mimo_api_key: String::new(),
            mimo_base_url: default_voice_mimo_base_url(),
            mimo_model: default_voice_mimo_model(),
            language: None,
            enable_itn: false,
            max_record_seconds: default_voice_max_record_seconds(),
        }
    }
}

impl Default for CCChanSettings {
    fn default() -> Self {
        Self {
            ai_engine: default_ccchan_ai_engine(),
            default_pet_id: default_ccchan_pet_id(),
            auto_start: false,
            sound_enabled: true,
            window_visible: false,
            window_x: None,
            window_y: None,
        }
    }
}

impl Default for WebAccessSettings {
    fn default() -> Self {
        Self {
            enabled: default_web_access_enabled(),
            auto_open: false,
            port: default_web_access_port(),
            allow_lan: false,
            ip_whitelist: Vec::new(),
            auth_enabled: false,
            username: default_web_access_username(),
            password_salt: None,
            password_hash: None,
            lock_on_idle_minutes: default_web_lock_on_idle_minutes(),
            remote_read_only: false,
        }
    }
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            close_to_tray: default_close_to_tray(),
            auto_start: false,
            language: "zh-CN".to_string(),
            data_dir: None,
            search_scope: SearchScope::default(),
            log_level: default_log_level(),
            onboarding_completed: false,
            default_cli_tool: default_cli_tool(),
            launch_favorites: default_launch_favorites(),
            // 新装用户默认收起非常用启动项（只见收藏的几条）。字段上的
            // #[serde(default)] 保持 false：老 config.toml 缺该键时行为不变。
            hide_non_favorite_launch_actions: true,
        }
    }
}

impl ProxySettings {
    /// 将代理配置转换为环境变量
    pub fn to_env_vars(&self) -> HashMap<String, String> {
        let mut vars = HashMap::new();
        if !self.enabled || self.host.is_empty() {
            return vars;
        }

        let auth = match (&self.username, &self.password) {
            (Some(user), Some(pass)) if !user.is_empty() => {
                format!(
                    "{}:{}@",
                    urlencoding::encode(user),
                    urlencoding::encode(pass)
                )
            }
            _ => String::new(),
        };

        let proxy_url = format!("{}://{}{}:{}", self.proxy_type, auth, self.host, self.port);

        vars.insert("HTTP_PROXY".to_string(), proxy_url.clone());
        vars.insert("HTTPS_PROXY".to_string(), proxy_url.clone());
        vars.insert("http_proxy".to_string(), proxy_url.clone());
        vars.insert("https_proxy".to_string(), proxy_url.clone());
        vars.insert("ALL_PROXY".to_string(), proxy_url);

        if let Some(ref no_proxy) = self.no_proxy {
            if !no_proxy.is_empty() {
                vars.insert("NO_PROXY".to_string(), no_proxy.clone());
                vars.insert("no_proxy".to_string(), no_proxy.clone());
            }
        }

        vars
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_defaults_include_pane_focus_bindings() {
        let bindings = ShortcutSettings::default().bindings;

        assert_eq!(
            bindings.get("focus-pane-left"),
            Some(&"Alt+Left".to_string())
        );
        assert_eq!(
            bindings.get("focus-pane-right"),
            Some(&"Alt+Right".to_string())
        );
        assert_eq!(bindings.get("focus-pane-up"), Some(&"Alt+Up".to_string()));
        assert_eq!(
            bindings.get("focus-pane-down"),
            Some(&"Alt+Down".to_string())
        );
        assert_eq!(bindings.get("voice-input"), Some(&"Ctrl+Alt+M".to_string()));
        assert_eq!(
            bindings.get("toggle-layouts"),
            Some(&"Ctrl+Alt+L".to_string())
        );
        assert_eq!(bindings.get("switch-layout-1"), Some(&"Alt+1".to_string()));
        assert_eq!(bindings.get("switch-layout-9"), Some(&"Alt+9".to_string()));
    }

    #[test]
    fn merge_missing_defaults_adds_switch_layout_bindings_for_legacy_settings() {
        let mut settings = ShortcutSettings {
            bindings: HashMap::from([("toggle-sidebar".to_string(), "Ctrl+B".to_string())]),
        };

        settings.merge_missing_defaults();

        assert_eq!(
            settings.bindings.get("switch-layout-3"),
            Some(&"Alt+3".to_string())
        );
    }

    #[test]
    fn merge_missing_defaults_preserves_existing_overrides() {
        let mut settings = ShortcutSettings {
            bindings: HashMap::from([("focus-pane-left".to_string(), "Ctrl+Alt+Left".to_string())]),
        };

        settings.merge_missing_defaults();

        assert_eq!(
            settings.bindings.get("focus-pane-left"),
            Some(&"Ctrl+Alt+Left".to_string())
        );
        assert_eq!(
            settings.bindings.get("focus-pane-right"),
            Some(&"Alt+Right".to_string())
        );
    }

    #[test]
    fn merge_missing_defaults_does_not_create_binding_conflicts() {
        let mut settings = ShortcutSettings {
            bindings: HashMap::from([("custom-action".to_string(), "Alt+Left".to_string())]),
        };

        settings.merge_missing_defaults();

        assert_eq!(
            settings.bindings.get("custom-action"),
            Some(&"Alt+Left".to_string())
        );
        assert!(!settings.bindings.contains_key("focus-pane-left"));
        assert_eq!(
            settings.bindings.get("focus-pane-right"),
            Some(&"Alt+Right".to_string())
        );
    }

    #[test]
    fn terminal_merge_missing_defaults_migrates_legacy_scrollback() {
        let mut settings = TerminalSettings::default();
        settings.scrollback = crate::constants::terminal::LEGACY_DEFAULT_SCROLLBACK;

        settings.merge_missing_defaults();

        assert_eq!(
            settings.scrollback,
            crate::constants::terminal::DEFAULT_SCROLLBACK
        );
    }

    #[test]
    fn terminal_merge_missing_defaults_preserves_custom_scrollback() {
        let mut settings = TerminalSettings::default();
        settings.scrollback = 5_000;

        settings.merge_missing_defaults();

        assert_eq!(settings.scrollback, 5_000);
    }

    #[test]
    fn terminal_merge_missing_defaults_resets_invalid_renderer_mode() {
        let mut settings = TerminalSettings::default();
        settings.renderer_mode = "unknown".to_string();

        settings.merge_missing_defaults();

        assert_eq!(settings.renderer_mode, "auto");
    }

    #[test]
    fn terminal_merge_missing_defaults_normalizes_appearance_values() {
        let mut settings = TerminalSettings::default();
        settings.font_size = 5;
        settings.theme_mode = "unknown".to_string();

        settings.merge_missing_defaults();

        assert_eq!(settings.font_size, DEFAULT_TERMINAL_FONT_SIZE);
        assert_eq!(settings.theme_mode, "followApp");
    }

    #[test]
    fn voice_merge_missing_defaults_normalizes_invalid_values() {
        let mut settings = VoiceSettings {
            provider: "unknown".to_string(),
            enabled: true,
            dashscope_api_key: "sk-test".to_string(),
            region: "invalid".to_string(),
            model: String::new(),
            mimo_api_key: "mimo-test".to_string(),
            mimo_base_url: " https://api.xiaomimimo.com/v1/ ".to_string(),
            mimo_model: String::new(),
            language: Some(" ".to_string()),
            enable_itn: true,
            max_record_seconds: 999,
        };

        settings.merge_missing_defaults();

        assert_eq!(settings.provider, "dashscope");
        assert_eq!(settings.region, "cn");
        assert_eq!(settings.model, "qwen3-asr-flash");
        assert_eq!(settings.mimo_base_url, "https://api.xiaomimimo.com/v1");
        assert_eq!(settings.mimo_model, "mimo-v2.5");
        assert_eq!(settings.language, None);
        assert_eq!(settings.max_record_seconds, 60);
    }

    #[test]
    fn app_settings_deserializes_cli_launchers_default_for_legacy_config() {
        let settings: AppSettings = toml::from_str("").unwrap();

        assert!(settings.cli_launchers.overrides.is_empty());
    }

    #[test]
    fn cli_launcher_settings_returns_trimmed_command() {
        let settings = CliLauncherSettings {
            overrides: HashMap::from([(
                "claude".to_string(),
                CliLauncherOverride {
                    command: "  C:\\Tools\\reclaude.exe  ".to_string(),
                },
            )]),
        };

        assert_eq!(
            settings.command_for("claude"),
            Some("C:\\Tools\\reclaude.exe")
        );
        assert_eq!(settings.command_for("codex"), None);
    }

    #[test]
    fn cli_launcher_merge_missing_defaults_removes_blank_commands() {
        let mut settings = CliLauncherSettings {
            overrides: HashMap::from([
                (
                    " claude ".to_string(),
                    CliLauncherOverride {
                        command: "  reclaude  ".to_string(),
                    },
                ),
                (
                    "codex".to_string(),
                    CliLauncherOverride {
                        command: "  ".to_string(),
                    },
                ),
                (
                    " ".to_string(),
                    CliLauncherOverride {
                        command: "tool".to_string(),
                    },
                ),
            ]),
        };

        settings.merge_missing_defaults();

        assert_eq!(settings.overrides.len(), 1);
        assert_eq!(settings.command_for("claude"), Some("reclaude"));
        assert_eq!(settings.command_for("codex"), None);
    }
}
