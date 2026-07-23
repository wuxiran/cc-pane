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
    pub local_history: LocalHistorySettings,
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
    #[serde(default)]
    pub wallpaper: WallpaperSettings,
}

/// Local History 全局设置。项目级配置只有在该开关开启时才生效。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHistorySettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for LocalHistorySettings {
    fn default() -> Self {
        Self { enabled: true }
    }
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
        self.wallpaper.merge_missing_defaults();
    }
}

/// 主区壁纸设置。
///
/// 每个字段都必须带 `#[serde(default)]`：老 config.toml 不含 [wallpaper] 子键时
/// 反序列化要能整体回落默认，缺任何一个 default 都会让老配置升级直接失败。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperSettings {
    #[serde(default)]
    pub enabled: bool,
    /// "none" | "image" | "video"
    #[serde(default = "default_wallpaper_kind")]
    pub kind: String,
    /// wallpapers_dir 下的相对文件名（受控 uuid 文件名），不存绝对路径
    #[serde(default)]
    pub file: Option<String>,
    /// "cover" | "contain" | "tile" | "center"
    #[serde(default = "default_wallpaper_fit")]
    pub fit: String,
    /// 媒体层不透明度 0.1..=1
    #[serde(default = "default_wallpaper_opacity")]
    pub opacity: f64,
    /// 高斯模糊半径 px 0..=64
    #[serde(default)]
    pub blur: f64,
    /// 压暗遮罩不透明度 0..=0.9
    #[serde(default = "default_wallpaper_dim")]
    pub dim: f64,
    /// 终端背景不透明度 0..=1（1 = 不透明走原路径；0 = 全透明，字直接浮在壁纸上）
    #[serde(default = "default_wallpaper_terminal_opacity")]
    pub terminal_opacity: f64,
    /// 面板玻璃模糊 px 0..=24：壁纸激活时面板背景变透明，面板自身的
    /// `backdrop-filter: blur(--app-glass-blur)` 会直接糊在壁纸上（视频会被糊没）。
    /// 这个值在壁纸激活时接管该 token，默认 0 = 壁纸之上不再叠玻璃模糊。
    #[serde(default)]
    pub glass_blur: f64,
    #[serde(default)]
    pub video: WallpaperVideoSettings,
    #[serde(default)]
    pub music: WallpaperMusicSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperVideoSettings {
    #[serde(default = "default_true")]
    pub autoplay: bool,
    /// 0.25..=2.0
    #[serde(default = "default_wallpaper_playback_rate")]
    pub playback_rate: f64,
    #[serde(default = "default_true")]
    pub pause_when_unfocused: bool,
    /// "auto" | "always" | "never"
    #[serde(default = "default_wallpaper_power_saver")]
    pub power_saver: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperMusicSettings {
    #[serde(default)]
    pub enabled: bool,
    /// wallpapers_dir 下的相对文件名
    #[serde(default)]
    pub file: Option<String>,
    /// 0..=1
    #[serde(default = "default_wallpaper_music_volume")]
    pub volume: f64,
    #[serde(default = "default_true")]
    pub loop_playback: bool,
    #[serde(default = "default_true")]
    pub autoplay: bool,
    /// 失焦是否暂停。**独立于 video.pauseWhenUnfocused**：BGM 属全局氛围，
    /// 切走窗口未必想停，所以默认 false（老配置升级后音乐不再随失焦暂停）。
    #[serde(default)]
    pub pause_when_unfocused: bool,
    /// 用视频壁纸自带的音轨当 BGM（仅 kind=video 有意义），忽略 `file`。
    ///
    /// 实现走**独立 audio 元素喂同一个文件**，不给 `<video>` 解除静音：
    /// 有声 video 的 autoplay 会被浏览器拒掉（整个视频停在首帧），
    /// 且省电策略一暂停视频声音就断。独立 audio 才能复用音乐的手势兜底与暂停规则。
    #[serde(default)]
    pub use_video_audio: bool,
}

/// 工作空间壁纸覆盖配置：**每个字段都是 Option**，未设 = 回落全局。
///
/// 不能复用 `WallpaperSettings`：它每个字段都带 `serde(default)`，部分覆盖一旦
/// 经 Rust 反序列化就会被补成完整对象写回 workspace.json，
/// 「未设字段回落全局」的语义会在第一次保存后永久失效。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperOverrideConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blur: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dim: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glass_blur: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<WallpaperVideoOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub music: Option<WallpaperMusicOverride>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperVideoOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autoplay: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_when_unfocused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub power_saver: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperMusicOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_playback: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autoplay: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_when_unfocused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_video_audio: Option<bool>,
}

impl Default for WallpaperSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            kind: default_wallpaper_kind(),
            file: None,
            fit: default_wallpaper_fit(),
            opacity: default_wallpaper_opacity(),
            blur: 0.0,
            dim: default_wallpaper_dim(),
            terminal_opacity: default_wallpaper_terminal_opacity(),
            glass_blur: 0.0,
            video: WallpaperVideoSettings::default(),
            music: WallpaperMusicSettings::default(),
        }
    }
}

impl Default for WallpaperVideoSettings {
    fn default() -> Self {
        Self {
            autoplay: true,
            playback_rate: default_wallpaper_playback_rate(),
            pause_when_unfocused: true,
            power_saver: default_wallpaper_power_saver(),
        }
    }
}

impl Default for WallpaperMusicSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            file: None,
            volume: default_wallpaper_music_volume(),
            loop_playback: true,
            autoplay: true,
            pause_when_unfocused: false,
            use_video_audio: false,
        }
    }
}

impl WallpaperSettings {
    pub fn merge_missing_defaults(&mut self) {
        if !matches!(self.kind.as_str(), "none" | "image" | "video") {
            self.kind = default_wallpaper_kind();
        }
        if !matches!(self.fit.as_str(), "cover" | "contain" | "tile" | "center") {
            self.fit = default_wallpaper_fit();
        }
        if !self.opacity.is_finite() || !(0.1..=1.0).contains(&self.opacity) {
            self.opacity = default_wallpaper_opacity();
        }
        if !self.blur.is_finite() || !(0.0..=64.0).contains(&self.blur) {
            self.blur = 0.0;
        }
        if !self.dim.is_finite() || !(0.0..=0.9).contains(&self.dim) {
            self.dim = default_wallpaper_dim();
        }
        if !self.terminal_opacity.is_finite() || !(0.0..=1.0).contains(&self.terminal_opacity) {
            self.terminal_opacity = default_wallpaper_terminal_opacity();
        }
        if !self.glass_blur.is_finite() || !(0.0..=24.0).contains(&self.glass_blur) {
            self.glass_blur = 0.0;
        }
        if !self.video.playback_rate.is_finite()
            || !(0.25..=2.0).contains(&self.video.playback_rate)
        {
            self.video.playback_rate = default_wallpaper_playback_rate();
        }
        if !matches!(self.video.power_saver.as_str(), "auto" | "always" | "never") {
            self.video.power_saver = default_wallpaper_power_saver();
        }
        if !self.music.volume.is_finite() || !(0.0..=1.0).contains(&self.music.volume) {
            self.music.volume = default_wallpaper_music_volume();
        }
    }
}

fn default_wallpaper_kind() -> String {
    "none".to_string()
}

fn default_wallpaper_fit() -> String {
    "cover".to_string()
}

fn default_wallpaper_opacity() -> f64 {
    1.0
}

fn default_wallpaper_dim() -> f64 {
    0.35
}

fn default_wallpaper_terminal_opacity() -> f64 {
    0.85
}

fn default_wallpaper_playback_rate() -> f64 {
    1.0
}

fn default_wallpaper_power_saver() -> String {
    "auto".to_string()
}

fn default_wallpaper_music_volume() -> f64 {
    0.5
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
    /// 终端会话共享：PTY 托管到 cc-panes-daemon 独立进程，桌面与 Web/移动端
    /// 附着同一批活会话（"无缝接力"）。重启应用生效。默认开启，让远程镜像开箱即用；
    /// 环境变量 CCPANES_TERMINAL_DAEMON 仍可覆盖强制开启（排障用）。
    #[serde(default = "default_daemon_enabled")]
    pub daemon_enabled: bool,
    /// daemon 孤儿会话过期时间（分钟）：会话无人查看（无 WS 订阅且无 HTTP 访问）
    /// 超过该时长后由 daemon 按先进先出回收。改动无需重启 daemon，
    /// 下一轮 sweep（约 60s）生效。要禁用回收请用 `daemon_orphan_reaper_disabled`，
    /// 历史值 0（旧默认"永不过期"）会在 merge_missing_defaults 中升为默认 TTL。
    #[serde(default = "default_daemon_orphan_ttl_minutes")]
    pub daemon_orphan_ttl_minutes: u32,
    /// 禁用 daemon 孤儿会话回收（true = 永不回收）。取代旧的"TTL=0 表示永不过期"语义。
    #[serde(default)]
    pub daemon_orphan_reaper_disabled: bool,
}

/// 孤儿会话 TTL 上限：7 天
pub const MAX_DAEMON_ORPHAN_TTL_MINUTES: u32 = 7 * 24 * 60;

/// 孤儿会话 TTL 默认值：24 小时
pub const DEFAULT_DAEMON_ORPHAN_TTL_MINUTES: u32 = 24 * 60;

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
        // 旧默认 0 =“永不过期”已废弃：无法区分显式 0 与旧默认落盘的 0，
        // 一律升为默认 TTL；确要禁用的用户改用 daemon_orphan_reaper_disabled。
        if self.daemon_orphan_ttl_minutes == 0 {
            self.daemon_orphan_ttl_minutes = DEFAULT_DAEMON_ORPHAN_TTL_MINUTES;
        }
        if self.daemon_orphan_ttl_minutes > MAX_DAEMON_ORPHAN_TTL_MINUTES {
            self.daemon_orphan_ttl_minutes = MAX_DAEMON_ORPHAN_TTL_MINUTES;
        }
    }
}

fn default_terminal_theme_mode() -> String {
    "followApp".to_string()
}

fn default_terminal_renderer_mode() -> String {
    "auto".to_string()
}

fn default_daemon_enabled() -> bool {
    true
}

fn default_daemon_orphan_ttl_minutes() -> u32 {
    DEFAULT_DAEMON_ORPHAN_TTL_MINUTES
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
    /// 禁用 WSL 用量统计扫描（禁用后启动/定时/手动刷新都不再触碰 \\wsl$ 与 wsl.exe）
    #[serde(default)]
    pub disable_wsl_usage_scan: bool,
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
    /// 是否在终端右下角显示语音悬浮按钮（关闭后仍可用快捷键触发录音）
    #[serde(default = "default_true")]
    pub show_floating_button: bool,
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
    // 随机漫游默认关闭：宠物待在原地，仍可手动拖拽。
    #[serde(default)]
    pub wander_enabled: bool,
    #[serde(default = "default_ccchan_pet_size")]
    pub pet_size: f64,
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
    /// 远程只读模式的例外：已通过密码鉴权的远程会话允许写入。
    /// 仅在 remote_read_only 开启且 auth_required() 为真时生效——
    /// 未配置密码时该开关不放行任何写入（fail-safe）。
    #[serde(default)]
    pub remote_authenticated_write: bool,
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

pub const CCCHAN_PET_SIZE_MIN: f64 = 80.0;
pub const CCCHAN_PET_SIZE_MAX: f64 = 240.0;

impl CCChanSettings {
    pub fn merge_missing_defaults(&mut self) {
        if !matches!(self.ai_engine.as_str(), "claude" | "codex") {
            self.ai_engine = default_ccchan_ai_engine();
        }
        if self.default_pet_id.trim().is_empty() {
            self.default_pet_id = default_ccchan_pet_id();
        }
        if !self.pet_size.is_finite()
            || !(CCCHAN_PET_SIZE_MIN..=CCCHAN_PET_SIZE_MAX).contains(&self.pet_size)
        {
            self.pet_size = default_ccchan_pet_size();
        }
    }
}

fn default_ccchan_ai_engine() -> String {
    "claude".to_string()
}

fn default_ccchan_pet_id() -> String {
    // 与前端 useCCChanStore 的 DEFAULT_CCCHAN_SETTINGS / FALLBACK_PET 保持一致。
    "homie".to_string()
}

fn default_ccchan_pet_size() -> f64 {
    120.0
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
            font_family: "\"Maple Mono NF CN\", \"Maple Mono\", \"Cascadia Code\", \"Cascadia Mono\", \"JetBrains Mono\", Consolas, \"Sarasa Mono SC\", \"Microsoft YaHei UI\", \"PingFang SC\", monospace".to_string(),
            cursor_style: "block".to_string(),
            cursor_blink: false,
            scrollback: crate::constants::terminal::DEFAULT_SCROLLBACK,
            theme_mode: default_terminal_theme_mode(),
            renderer_mode: default_terminal_renderer_mode(),
            shell: None,
            disable_conpty_sanitize: None,
            resume_id_backfill_enabled: None,
            daemon_enabled: true,
            daemon_orphan_ttl_minutes: default_daemon_orphan_ttl_minutes(),
            daemon_orphan_reaper_disabled: false,
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
        bindings.insert("command-palette".to_string(), "Ctrl+K".to_string());
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
            show_floating_button: true,
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
            wander_enabled: false,
            pet_size: default_ccchan_pet_size(),
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
            remote_authenticated_write: false,
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
            disable_wsl_usage_scan: false,
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
    fn terminal_settings_without_orphan_ttl_defaults_to_24h() {
        // 老 config.toml 无该键时不报错，回落到默认 24h；禁用开关默认关闭。
        let toml_str = r#"
            fontSize = 15
            fontFamily = "monospace"
            cursorStyle = "block"
            cursorBlink = false
            scrollback = 20000
        "#;
        let settings: TerminalSettings = toml::from_str(toml_str).expect("parse legacy config");
        assert_eq!(
            settings.daemon_orphan_ttl_minutes,
            DEFAULT_DAEMON_ORPHAN_TTL_MINUTES
        );
        assert!(!settings.daemon_orphan_reaper_disabled);
    }

    #[test]
    fn merge_missing_defaults_clamps_orphan_ttl_to_seven_days() {
        let mut settings = TerminalSettings {
            daemon_orphan_ttl_minutes: MAX_DAEMON_ORPHAN_TTL_MINUTES + 1,
            ..TerminalSettings::default()
        };
        settings.merge_missing_defaults();
        assert_eq!(
            settings.daemon_orphan_ttl_minutes,
            MAX_DAEMON_ORPHAN_TTL_MINUTES
        );
    }

    #[test]
    fn merge_missing_defaults_migrates_legacy_zero_ttl_to_default() {
        // 旧默认 0 =“永不过期”已废弃：无法区分显式 0 与旧默认落盘的 0，
        // 一律升为默认 TTL；永不回收由 daemon_orphan_reaper_disabled 表达。
        let mut zero = TerminalSettings {
            daemon_orphan_ttl_minutes: 0,
            ..TerminalSettings::default()
        };
        zero.merge_missing_defaults();
        assert_eq!(
            zero.daemon_orphan_ttl_minutes,
            DEFAULT_DAEMON_ORPHAN_TTL_MINUTES
        );
    }

    #[test]
    fn merge_missing_defaults_preserves_reaper_disabled_flag() {
        let mut settings = TerminalSettings {
            daemon_orphan_reaper_disabled: true,
            daemon_orphan_ttl_minutes: 0,
            ..TerminalSettings::default()
        };
        settings.merge_missing_defaults();
        // 禁用开关保留；TTL 仍被迁移但不影响禁用语义（reaper 先查开关）
        assert!(settings.daemon_orphan_reaper_disabled);
        assert_eq!(
            settings.daemon_orphan_ttl_minutes,
            DEFAULT_DAEMON_ORPHAN_TTL_MINUTES
        );
    }

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
    fn ccchan_merge_missing_defaults_normalizes_pet_size_and_pet_id() {
        let mut settings = CCChanSettings::default();
        assert!(!settings.wander_enabled);
        assert_eq!(settings.pet_size, 120.0);
        assert_eq!(settings.default_pet_id, "homie");

        settings.pet_size = 10.0;
        settings.default_pet_id = "  ".to_string();
        settings.merge_missing_defaults();
        assert_eq!(settings.pet_size, 120.0);
        assert_eq!(settings.default_pet_id, "homie");

        settings.pet_size = f64::NAN;
        settings.merge_missing_defaults();
        assert_eq!(settings.pet_size, 120.0);

        settings.pet_size = 240.0;
        settings.merge_missing_defaults();
        assert_eq!(settings.pet_size, 240.0);
    }

    #[test]
    fn ccchan_settings_deserializes_legacy_config_without_new_fields() {
        let settings: CCChanSettings =
            serde_json::from_str(r#"{"aiEngine":"claude","defaultPetId":"doro.codex-pet"}"#)
                .expect("legacy ccchan settings");
        assert!(!settings.wander_enabled);
        assert_eq!(settings.pet_size, 120.0);
        assert_eq!(settings.default_pet_id, "doro.codex-pet");
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
            show_floating_button: true,
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
    fn app_settings_deserializes_wallpaper_default_for_legacy_config() {
        // 老 config.toml 完全没有 [wallpaper]：整块回落默认，不能报错。
        let settings: AppSettings = toml::from_str("").unwrap();
        assert!(!settings.wallpaper.enabled);
        assert_eq!(settings.wallpaper.kind, "none");
        assert_eq!(settings.wallpaper.video.power_saver, "auto");
        assert_eq!(settings.wallpaper.music.volume, 0.5);
    }

    #[test]
    fn wallpaper_deserializes_partial_config_with_missing_nested_blocks() {
        // 只写了顶层字段、缺 video/music 子块：逐字段回落默认。
        let toml_str = r#"
            enabled = true
            kind = "image"
            file = "abc.png"
        "#;
        let settings: WallpaperSettings = toml::from_str(toml_str).expect("partial wallpaper");
        assert!(settings.enabled);
        assert_eq!(settings.file.as_deref(), Some("abc.png"));
        assert_eq!(settings.fit, "cover");
        assert!(settings.video.autoplay);
        assert!(settings.music.loop_playback);
    }

    #[test]
    fn legacy_config_without_music_pause_when_unfocused_deserializes_to_false() {
        // 老用户的 config.toml：[wallpaper.music] 存在但没有 pauseWhenUnfocused 字段。
        // 反序列化不能崩，且新字段落到 false（BGM 不随失焦暂停）。
        let toml_str = r#"
            [wallpaper]
            enabled = true
            kind = "image"
            file = "old.png"

            [wallpaper.video]
            autoplay = true
            playbackRate = 1.0
            pauseWhenUnfocused = true
            powerSaver = "auto"

            [wallpaper.music]
            enabled = true
            file = "bgm.mp3"
            volume = 0.4
            loopPlayback = true
            autoplay = true
        "#;
        let mut settings: AppSettings = toml::from_str(toml_str).expect("legacy config");
        settings.merge_missing_defaults();

        assert!(settings.wallpaper.music.enabled);
        assert_eq!(settings.wallpaper.music.volume, 0.4);
        assert!(settings.wallpaper.video.pause_when_unfocused);
        assert!(!settings.wallpaper.music.pause_when_unfocused);
        // 老配置没有 glassBlur：落 0，壁纸之上不再叠面板玻璃模糊
        assert_eq!(settings.wallpaper.glass_blur, 0.0);
        // 老配置没有 useVideoAudio：落 false，仍走 music.file
        assert!(!settings.wallpaper.music.use_video_audio);
    }

    #[test]
    fn glass_blur_clamps_out_of_range_to_zero() {
        let mut settings = WallpaperSettings {
            glass_blur: 999.0,
            ..WallpaperSettings::default()
        };
        settings.merge_missing_defaults();
        assert_eq!(settings.glass_blur, 0.0);

        let mut ok = WallpaperSettings {
            glass_blur: 12.0,
            ..WallpaperSettings::default()
        };
        ok.merge_missing_defaults();
        assert_eq!(ok.glass_blur, 12.0);
    }

    #[test]
    fn wallpaper_override_config_keeps_unset_fields_absent_through_roundtrip() {
        // 关键：部分覆盖经 Rust 反序列化 + 再序列化后，未设字段必须仍然缺席，
        // 否则前端 resolveWallpaper 的「未设回落全局」在第一次保存后就失效。
        let json = r#"{"enabled":true,"kind":"image","file":"ws.png","music":{"pauseWhenUnfocused":true}}"#;
        let config: WallpaperOverrideConfig = serde_json::from_str(json).expect("partial override");

        assert_eq!(config.enabled, Some(true));
        assert!(config.dim.is_none());
        assert!(config.video.is_none());
        assert_eq!(
            config.music.as_ref().and_then(|m| m.pause_when_unfocused),
            Some(true)
        );
        assert!(config.music.as_ref().and_then(|m| m.volume).is_none());

        let out = serde_json::to_string(&config).expect("serialize override");
        assert!(!out.contains("dim"), "未设字段不应被补进序列化结果: {out}");
        assert!(!out.contains("terminalOpacity"), "{out}");
        assert!(!out.contains("\"video\""), "{out}");
        assert!(out.contains("pauseWhenUnfocused"));
    }

    /// 老 workspace.json 是被旧代码（config: WallpaperSettings）写出的**完整**对象，
    /// 换成部分覆盖结构后必须仍能读进来，不能让老工作空间的壁纸设置炸掉。
    #[test]
    fn legacy_full_override_config_still_deserializes() {
        let json = r#"{
            "enabled":true,"kind":"image","file":"ws.png","fit":"cover",
            "opacity":1.0,"blur":0.0,"dim":0.35,"terminalOpacity":0.85,
            "video":{"autoplay":true,"playbackRate":1.0,"pauseWhenUnfocused":true,"powerSaver":"auto"},
            "music":{"enabled":false,"file":null,"volume":0.5,"loopPlayback":true,"autoplay":true}
        }"#;
        let config: WallpaperOverrideConfig = serde_json::from_str(json).expect("legacy override");

        assert_eq!(config.file.as_deref(), Some("ws.png"));
        assert_eq!(config.dim, Some(0.35));
        assert_eq!(
            config.video.as_ref().unwrap().power_saver.as_deref(),
            Some("auto")
        );
        // 老结构没有 music.pauseWhenUnfocused，读进来是 None（= 不覆盖，回落全局）
        assert!(config
            .music
            .as_ref()
            .unwrap()
            .pause_when_unfocused
            .is_none());
    }

    #[test]
    fn wallpaper_override_config_supports_full_parameter_override() {
        let json = r#"{
            "opacity":0.5,"blur":12.0,"dim":0.7,"terminalOpacity":0.4,
            "video":{"playbackRate":0.5,"pauseWhenUnfocused":false},
            "music":{"volume":0.2,"pauseWhenUnfocused":true}
        }"#;
        let config: WallpaperOverrideConfig = serde_json::from_str(json).expect("full override");

        assert_eq!(config.opacity, Some(0.5));
        assert_eq!(config.blur, Some(12.0));
        assert_eq!(config.dim, Some(0.7));
        assert_eq!(config.terminal_opacity, Some(0.4));
        assert_eq!(config.video.as_ref().unwrap().playback_rate, Some(0.5));
        assert_eq!(
            config.video.as_ref().unwrap().pause_when_unfocused,
            Some(false)
        );
        assert_eq!(config.music.as_ref().unwrap().volume, Some(0.2));
    }

    #[test]
    fn wallpaper_merge_missing_defaults_clamps_invalid_values() {
        let mut settings = WallpaperSettings {
            kind: "gif".to_string(),
            fit: "stretch".to_string(),
            opacity: 3.0,
            blur: -1.0,
            dim: f64::NAN,
            terminal_opacity: -1.0,
            ..WallpaperSettings::default()
        };
        settings.video.playback_rate = 10.0;
        settings.video.power_saver = "eco".to_string();
        settings.music.volume = 2.0;

        settings.merge_missing_defaults();

        assert_eq!(settings.kind, "none");
        assert_eq!(settings.fit, "cover");
        assert_eq!(settings.opacity, 1.0);
        assert_eq!(settings.blur, 0.0);
        assert_eq!(settings.dim, 0.35);
        assert_eq!(settings.terminal_opacity, 0.85);
        assert_eq!(settings.video.playback_rate, 1.0);
        assert_eq!(settings.video.power_saver, "auto");
        assert_eq!(settings.music.volume, 0.5);
    }

    /// terminalOpacity 下限从 0.3 放宽到 0：0 = 全透明，字直接浮在壁纸上。
    #[test]
    fn terminal_opacity_zero_is_valid_full_transparency() {
        let mut settings = WallpaperSettings {
            terminal_opacity: 0.0,
            ..WallpaperSettings::default()
        };
        settings.merge_missing_defaults();
        assert_eq!(settings.terminal_opacity, 0.0);

        let mut low = WallpaperSettings {
            terminal_opacity: 0.1,
            ..WallpaperSettings::default()
        };
        low.merge_missing_defaults();
        assert_eq!(low.terminal_opacity, 0.1);
    }

    #[test]
    fn general_disable_wsl_usage_scan_defaults_false_for_legacy_config() {
        let toml_str = r#"
            closeToTray = true
            autoStart = false
            language = "zh-CN"
        "#;
        let settings: GeneralSettings = toml::from_str(toml_str).expect("parse legacy general");
        assert!(!settings.disable_wsl_usage_scan);
        assert!(!GeneralSettings::default().disable_wsl_usage_scan);
    }

    #[test]
    fn local_history_defaults_enabled_for_legacy_settings() {
        let settings: AppSettings = toml::from_str("").expect("parse legacy settings");
        assert!(settings.local_history.enabled);
        assert!(AppSettings::default().local_history.enabled);
    }

    #[test]
    fn local_history_explicit_disable_is_preserved() {
        let settings: AppSettings = toml::from_str(
            r#"
                [localHistory]
                enabled = false
            "#,
        )
        .expect("parse local history settings");
        assert!(!settings.local_history.enabled);
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
