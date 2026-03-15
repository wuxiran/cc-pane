use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    /// 用户选择的 Shell ID（如 "pwsh", "cmd", "git-bash"），None 表示自动探测
    #[serde(default)]
    pub shell: Option<String>,
    /// 禁用 ConPTY 输出 sanitize（默认 true，即禁用 sanitize，因为 dwFlags=0 已解决根本问题）
    #[serde(default)]
    pub disable_conpty_sanitize: Option<bool>,
}

/// 快捷键设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    pub bindings: HashMap<String, String>, // actionId -> keyCombo
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
}

fn default_cli_tool() -> String {
    "claude".to_string()
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
            font_size: 14,
            font_family: "Consolas, \"Courier New\", monospace".to_string(),
            cursor_style: "block".to_string(),
            cursor_blink: true,
            scrollback: crate::constants::terminal::DEFAULT_SCROLLBACK,
            shell: None,
            disable_conpty_sanitize: None,
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
        bindings.insert("split-right".to_string(), "Ctrl+\\".to_string());
        bindings.insert("split-down".to_string(), "Ctrl+-".to_string());
        bindings.insert("next-tab".to_string(), "Ctrl+Tab".to_string());
        bindings.insert("prev-tab".to_string(), "Ctrl+Shift+Tab".to_string());
        bindings.insert("toggle-mini-mode".to_string(), "Ctrl+M".to_string());
        for i in 1..=9 {
            bindings.insert(format!("switch-tab-{}", i), format!("Ctrl+{}", i));
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

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            auto_start: false,
            language: "zh-CN".to_string(),
            data_dir: None,
            search_scope: SearchScope::default(),
            log_level: default_log_level(),
            onboarding_completed: false,
            default_cli_tool: default_cli_tool(),
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

        let proxy_url = format!(
            "{}://{}{}:{}",
            self.proxy_type, auth, self.host, self.port
        );

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
