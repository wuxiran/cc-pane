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
    #[serde(default)]
    pub voice: VoiceSettings,
}

impl AppSettings {
    pub fn merge_missing_defaults(&mut self) {
        self.terminal.merge_missing_defaults();
        self.shortcuts.merge_missing_defaults();
        self.voice.merge_missing_defaults();
    }
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
    /// 终端渲染器: "auto" | "webgl" | "dom"
    #[serde(default = "default_terminal_renderer_mode")]
    pub renderer_mode: String,
    /// 用户选择的 Shell ID（如 "pwsh", "cmd", "git-bash"），None 表示自动探测
    #[serde(default)]
    pub shell: Option<String>,
    /// 禁用 ConPTY 输出 sanitize（默认 true，即禁用 sanitize，因为 dwFlags=0 已解决根本问题）
    #[serde(default)]
    pub disable_conpty_sanitize: Option<bool>,
}

impl TerminalSettings {
    pub fn merge_missing_defaults(&mut self) {
        if self.scrollback == crate::constants::terminal::LEGACY_DEFAULT_SCROLLBACK {
            self.scrollback = crate::constants::terminal::DEFAULT_SCROLLBACK;
        }
        if !matches!(self.renderer_mode.as_str(), "auto" | "webgl" | "dom") {
            self.renderer_mode = default_terminal_renderer_mode();
        }
    }
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

fn default_launch_favorites() -> Vec<String> {
    vec![
        "terminal-default".to_string(),
        "claude-local".to_string(),
        "codex-local".to_string(),
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
            renderer_mode: default_terminal_renderer_mode(),
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
            launch_favorites: default_launch_favorites(),
            hide_non_favorite_launch_actions: false,
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
}
