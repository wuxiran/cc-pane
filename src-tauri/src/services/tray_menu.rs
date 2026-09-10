//! 系统托盘菜单：纯函数菜单决策（`build_menu_spec`）+ Tauri 薄控制器（`TrayMenuController`）。
//!
//! ## 分层
//! - 纯数据进/出：`TraySnapshot`（会话快照 + 通知偏好）与 `TrayMenuSettings`（设置快照）
//!   经 `build_menu_spec` 得到 `MenuSpec`，全部菜单结构决策在此，可脱离 Tauri 单测。
//! - 控制器只负责：采集快照（TerminalBackendState + OrchestratorService 校正 +
//!   TaskBindingService 取会话名）、300ms 节流、spec → 原生 Menu 转换、事件分发。
//!
//! ## 与前端的事件契约（勿擅自改动）
//! - emit `tray-action`，payload：
//!   `{"action":"focus-session","sessionId":..}` / `{"action":"new-session"}` /
//!   `{"action":"open-settings","section":"tray"}` / `{"action":"confirm-quit","runningCount":n}`
//! - 通知偏好切换后 emit `notification-preferences-changed`（与前端命令同一事件名）。

use cc_panes_core::models::settings::GeneralSettings;
use cc_panes_core::services::terminal_service::SessionStatus;
use cc_panes_core::services::{SettingsService, TaskBindingService, WorkspaceService};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tracing::warn;

use crate::services::notification_preferences::{now_ms, NotificationPreferenceService};
use crate::services::{OrchestratorService, TerminalBackendState};

#[cfg(test)]
#[path = "tray_menu_tests.rs"]
mod tray_menu_tests;

// ---------- 菜单项 ID ----------

pub const ID_SUMMARY: &str = "tray-summary";
pub const ID_NEW_SESSION: &str = "tray-new-session";
pub const ID_SCREENSHOT: &str = "tray-screenshot";
pub const ID_MUTE_SOUND: &str = "tray-mute-sound";
pub const ID_SHOW_WINDOW: &str = "tray-show-window";
pub const ID_OPEN_SETTINGS: &str = "tray-open-settings";
pub const ID_QUIT: &str = "tray-quit";
/// 「暂停所有提醒」二级子菜单：时长档 + 手动恢复。
pub const ID_PAUSE_SUBMENU: &str = "tray-pause";
pub const ID_PAUSE_15MIN: &str = "tray-pause-15min";
pub const ID_PAUSE_1HOUR: &str = "tray-pause-1hour";
pub const ID_PAUSE_TODAY: &str = "tray-pause-today";
pub const ID_PAUSE_INDEFINITE: &str = "tray-pause-indefinite";
pub const ID_PAUSE_RESUME: &str = "tray-pause-resume";
/// 「切换工作区」二级子菜单；项 ID 前缀：`tray-workspace:<workspace_id>`
pub const ID_WORKSPACE_SUBMENU: &str = "tray-workspaces";
pub const WORKSPACE_ID_PREFIX: &str = "tray-workspace:";
/// 「设置」二级子菜单：通用开关直接勾选，不再只跳主窗口。
pub const ID_SETTINGS_SUBMENU: &str = "tray-settings";
pub const ID_SET_CLOSE_TO_TRAY: &str = "tray-set-close-to-tray";
pub const ID_SET_SHOW_STATUS: &str = "tray-set-show-status";
pub const ID_SET_TOOLTIP_SUMMARY: &str = "tray-set-tooltip-summary";
pub const ID_SET_CONFIRM_QUIT: &str = "tray-set-confirm-quit";
/// 待处理条数单选项前缀：`tray-set-max-pending:<n>`
pub const MAX_PENDING_ID_PREFIX: &str = "tray-set-max-pending:";
/// 待处理条数单选档。
pub const MAX_PENDING_OPTIONS: [u8; 3] = [3, 5, 10];
pub const ID_CHECK_UPDATES: &str = "tray-check-updates";
/// 待处理会话项 ID 前缀：`tray-pending:<session_id>`
pub const PENDING_ID_PREFIX: &str = "tray-pending:";
/// 转发前端的托盘动作事件名（契约）。
pub const TRAY_ACTION_EVENT: &str = "tray-action";
/// 偏好变更事件名（与 notification_preference_commands 一致）。
pub const PREFS_CHANGED_EVENT: &str = "notification-preferences-changed";
/// 托盘勾选通用设置后广播（前端设置页开着时借此刷新）。
pub const SETTINGS_CHANGED_EVENT: &str = "settings-changed";

const REFRESH_THROTTLE: Duration = Duration::from_millis(300);
/// 待处理区条数上限的硬顶，防止异常设置值撑爆菜单。
const MAX_PENDING_CAP: u8 = 20;
/// 菜单里会话名最大字符数。
const MAX_NAME_CHARS: usize = 24;

// ---------- 语言 ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayLang {
    ZhCn,
    En,
}

/// settings.general.language 形如 "zh-CN" / "en-US"；非 zh 一律走英文表。
pub fn resolve_lang(raw: &str) -> TrayLang {
    if raw.trim().to_ascii_lowercase().starts_with("zh") {
        TrayLang::ZhCn
    } else {
        TrayLang::En
    }
}

#[derive(Debug, Clone, Copy)]
enum Key {
    SummaryNone,
    NewSession,
    Screenshot,
    PauseSubmenu,
    Pause15Min,
    Pause1Hour,
    PauseToday,
    PauseIndefinite,
    PauseResume,
    PausedSuffix,
    MuteSound,
    WorkspaceSubmenu,
    CheckUpdates,
    ShowWindow,
    Settings,
    CloseToTray,
    ShowStatusCheck,
    TooltipSummaryCheck,
    ConfirmQuitCheck,
    OpenFullSettings,
    Quit,
    WaitingLabel,
    ErrorLabel,
    JustNow,
    SessionFallback,
}

fn tr(lang: TrayLang, key: Key) -> &'static str {
    use TrayLang::*;
    match (lang, key) {
        (ZhCn, Key::SummaryNone) => "无运行中的会话",
        (En, Key::SummaryNone) => "No running sessions",
        (ZhCn, Key::NewSession) => "新建会话 / 对 agent 说",
        (En, Key::NewSession) => "New Session / Talk to Agent",
        (ZhCn, Key::Screenshot) => "区域截图",
        (En, Key::Screenshot) => "Region Screenshot",
        (ZhCn, Key::PauseSubmenu) => "暂停所有提醒",
        (En, Key::PauseSubmenu) => "Pause All Notifications",
        (ZhCn, Key::Pause15Min) => "15 分钟",
        (En, Key::Pause15Min) => "15 Minutes",
        (ZhCn, Key::Pause1Hour) => "1 小时",
        (En, Key::Pause1Hour) => "1 Hour",
        (ZhCn, Key::PauseToday) => "今天",
        (En, Key::PauseToday) => "Rest of Today",
        (ZhCn, Key::PauseIndefinite) => "直到手动恢复",
        (En, Key::PauseIndefinite) => "Until Resumed Manually",
        (ZhCn, Key::PauseResume) => "恢复提醒",
        (En, Key::PauseResume) => "Resume Notifications",
        (ZhCn, Key::PausedSuffix) => "已暂停",
        (En, Key::PausedSuffix) => "paused",
        (ZhCn, Key::MuteSound) => "静音提示音",
        (En, Key::MuteSound) => "Mute Notification Sounds",
        (ZhCn, Key::WorkspaceSubmenu) => "切换工作区",
        (En, Key::WorkspaceSubmenu) => "Switch Workspace",
        (ZhCn, Key::CheckUpdates) => "检查更新",
        (En, Key::CheckUpdates) => "Check for Updates",
        (ZhCn, Key::ShowWindow) => "显示主窗口",
        (En, Key::ShowWindow) => "Show Main Window",
        (ZhCn, Key::Settings) => "设置",
        (En, Key::Settings) => "Settings",
        (ZhCn, Key::CloseToTray) => "关闭时最小化到托盘",
        (En, Key::CloseToTray) => "Minimize to Tray on Close",
        (ZhCn, Key::ShowStatusCheck) => "菜单显示会话状态",
        (En, Key::ShowStatusCheck) => "Show Session Status in Menu",
        (ZhCn, Key::TooltipSummaryCheck) => "悬停提示状态摘要",
        (En, Key::TooltipSummaryCheck) => "Status Summary in Tooltip",
        (ZhCn, Key::ConfirmQuitCheck) => "退出前确认",
        (En, Key::ConfirmQuitCheck) => "Confirm Before Quit",
        (ZhCn, Key::OpenFullSettings) => "打开完整设置…",
        (En, Key::OpenFullSettings) => "Open Full Settings…",
        (ZhCn, Key::Quit) => "退出",
        (En, Key::Quit) => "Quit",
        (ZhCn, Key::WaitingLabel) => "等待输入",
        (En, Key::WaitingLabel) => "waiting input",
        (ZhCn, Key::ErrorLabel) => "出错",
        (En, Key::ErrorLabel) => "error",
        (ZhCn, Key::JustNow) => "刚刚",
        (En, Key::JustNow) => "just now",
        (ZhCn, Key::SessionFallback) => "会话",
        (En, Key::SessionFallback) => "Session",
    }
}

// ---------- 纯数据模型 ----------

/// 单个会话的托盘快照。`name` 仅对待处理会话填充（其余不必查库）。
#[derive(Debug, Clone)]
pub struct TraySessionEntry {
    pub session_id: String,
    pub name: String,
    pub status: SessionStatus,
    /// 当前状态开始的 epoch 毫秒（SessionStatusInfo.updated_at）。
    pub status_since_ms: u64,
}

/// 工作区切换项的托盘快照（按 created_at 倒序截取，见控制器）。
#[derive(Debug, Clone)]
pub struct TrayWorkspaceEntry {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct TraySnapshot {
    pub sessions: Vec<TraySessionEntry>,
    /// 全局暂停原始截止（`u64::MAX` = 直到手动恢复）；菜单层与 now_ms 比较出模式。
    pub paused_until: Option<u64>,
    pub sound_muted: bool,
    pub workspaces: Vec<TrayWorkspaceEntry>,
    pub now_ms: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct TrayMenuSettings {
    pub show_session_status: bool,
    pub max_pending_entries: u8,
    pub tooltip_summary: bool,
    pub confirm_quit: bool,
    pub close_to_tray: bool,
}

impl Default for TrayMenuSettings {
    fn default() -> Self {
        Self {
            show_session_status: true,
            max_pending_entries: 5,
            tooltip_summary: true,
            confirm_quit: true,
            close_to_tray: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuEntry {
    Item {
        id: String,
        text: String,
        enabled: bool,
    },
    CheckItem {
        id: String,
        text: String,
        checked: bool,
    },
    Submenu {
        id: String,
        text: String,
        items: Vec<MenuEntry>,
    },
    Separator,
}

/// 菜单结构决策结果。`tooltip_summary` 为 None 时 tooltip 只显示应用名。
#[derive(Debug, Clone, Default)]
pub struct MenuSpec {
    pub entries: Vec<MenuEntry>,
    pub tooltip_summary: Option<String>,
    pub running_sessions: u32,
    pub quit_needs_confirm: bool,
}

// ---------- 纯函数：菜单结构决策 ----------

pub fn build_menu_spec(
    snapshot: &TraySnapshot,
    settings: &TrayMenuSettings,
    lang: TrayLang,
) -> MenuSpec {
    let counts = count_sessions(&snapshot.sessions);
    let summary = summary_line(&counts, lang);
    let mut entries = Vec::new();
    if settings.show_session_status {
        entries.push(summary_entry(&counts, &summary, lang));
        let pending = pending_entries(snapshot, settings, lang);
        if !pending.is_empty() {
            entries.push(MenuEntry::Separator);
            entries.extend(pending);
        }
        entries.push(MenuEntry::Separator);
    }
    entries.push(action_item(ID_NEW_SESSION, tr(lang, Key::NewSession)));
    entries.push(action_item(ID_SCREENSHOT, tr(lang, Key::Screenshot)));
    if !snapshot.workspaces.is_empty() {
        entries.push(workspace_submenu(snapshot, lang));
    }
    entries.push(MenuEntry::Separator);
    entries.push(pause_submenu(snapshot, lang));
    entries.push(check_item(
        ID_MUTE_SOUND,
        tr(lang, Key::MuteSound),
        snapshot.sound_muted,
    ));
    entries.push(MenuEntry::Separator);
    entries.push(action_item(ID_SHOW_WINDOW, tr(lang, Key::ShowWindow)));
    entries.push(action_item(ID_CHECK_UPDATES, tr(lang, Key::CheckUpdates)));
    entries.push(settings_submenu(settings, lang));
    entries.push(action_item(ID_QUIT, tr(lang, Key::Quit)));

    let tooltip_summary =
        (settings.show_session_status && settings.tooltip_summary && counts.running > 0)
            .then_some(summary);
    MenuSpec {
        entries,
        tooltip_summary,
        running_sessions: counts.running,
        quit_needs_confirm: settings.confirm_quit && counts.running > 0,
    }
}

#[derive(Default)]
struct StatusCounts {
    running: u32,
    waiting: u32,
    error: u32,
}

/// 「运行中」= 进程未退出（含等待输入/出错，它们仍是活会话）。
fn count_sessions(sessions: &[TraySessionEntry]) -> StatusCounts {
    let mut counts = StatusCounts::default();
    for session in sessions {
        if session.status.is_terminal() {
            continue;
        }
        counts.running += 1;
        match session.status {
            SessionStatus::WaitingInput => counts.waiting += 1,
            SessionStatus::Error => counts.error += 1,
            _ => {}
        }
    }
    counts
}

fn summary_line(counts: &StatusCounts, lang: TrayLang) -> String {
    match lang {
        TrayLang::ZhCn => format!(
            "{} 个会话运行中 · {} 个等待输入 · {} 个出错",
            counts.running, counts.waiting, counts.error
        ),
        TrayLang::En => format!(
            "{} running · {} waiting input · {} error",
            counts.running, counts.waiting, counts.error
        ),
    }
}

fn summary_entry(counts: &StatusCounts, summary: &str, lang: TrayLang) -> MenuEntry {
    if counts.running == 0 {
        MenuEntry::Item {
            id: ID_SUMMARY.to_string(),
            text: tr(lang, Key::SummaryNone).to_string(),
            enabled: false,
        }
    } else {
        MenuEntry::Item {
            id: ID_SUMMARY.to_string(),
            text: summary.to_string(),
            enabled: true,
        }
    }
}

/// 待处理会话区：等待输入/出错，按进入当前状态的时间升序（等最久的排最前），
/// 超上限截断。无待处理时整区隐藏（由调用方决定是否插入分隔线）。
fn pending_entries(
    snapshot: &TraySnapshot,
    settings: &TrayMenuSettings,
    lang: TrayLang,
) -> Vec<MenuEntry> {
    let mut pending: Vec<&TraySessionEntry> = snapshot
        .sessions
        .iter()
        .filter(|s| matches!(s.status, SessionStatus::WaitingInput | SessionStatus::Error))
        .collect();
    pending.sort_by_key(|s| s.status_since_ms);
    let max = settings.max_pending_entries.clamp(1, MAX_PENDING_CAP) as usize;
    pending.truncate(max);
    pending
        .into_iter()
        .map(|session| MenuEntry::Item {
            id: pending_item_id(&session.session_id),
            text: pending_text(session, snapshot.now_ms, lang),
            enabled: true,
        })
        .collect()
}

fn pending_text(entry: &TraySessionEntry, now_ms: u64, lang: TrayLang) -> String {
    let duration = duration_text(now_ms.saturating_sub(entry.status_since_ms), lang);
    let name = display_name(entry, lang);
    let (icon, label) = match entry.status {
        SessionStatus::WaitingInput => ("⏳", tr(lang, Key::WaitingLabel)),
        _ => ("❗", tr(lang, Key::ErrorLabel)),
    };
    format!("{icon} {name} — {label} {duration}")
}

fn duration_text(elapsed_ms: u64, lang: TrayLang) -> String {
    let minutes = elapsed_ms / 60_000;
    if minutes < 1 {
        return tr(lang, Key::JustNow).to_string();
    }
    if minutes < 60 {
        return match lang {
            TrayLang::ZhCn => format!("{minutes} 分钟"),
            TrayLang::En => format!("{minutes} min"),
        };
    }
    let hours = minutes / 60;
    match lang {
        TrayLang::ZhCn => format!("{hours} 小时"),
        TrayLang::En => format!("{hours} h"),
    }
}

fn display_name(entry: &TraySessionEntry, lang: TrayLang) -> String {
    let trimmed = entry.name.trim();
    if !trimmed.is_empty() {
        return trimmed.chars().take(MAX_NAME_CHARS).collect();
    }
    let short: String = entry.session_id.chars().take(8).collect();
    format!("{} {}", tr(lang, Key::SessionFallback), short)
}

fn action_item(id: &str, text: &str) -> MenuEntry {
    MenuEntry::Item {
        id: id.to_string(),
        text: text.to_string(),
        enabled: true,
    }
}

fn check_item(id: &str, text: &str, checked: bool) -> MenuEntry {
    MenuEntry::CheckItem {
        id: id.to_string(),
        text: text.to_string(),
        checked,
    }
}

fn pending_item_id(session_id: &str) -> String {
    format!("{PENDING_ID_PREFIX}{session_id}")
}

/// 「今天」档的截止：本地次日 0 点（异常时兜底 12 小时）。
fn end_of_today_ms() -> u64 {
    use chrono::{Local, TimeZone};
    let now = Local::now();
    let tomorrow = (now + chrono::Duration::days(1)).date_naive();
    tomorrow
        .and_hms_opt(0, 0, 0)
        .and_then(|midnight| Local.from_local_datetime(&midnight).single())
        .map(|midnight| midnight.timestamp_millis() as u64)
        .unwrap_or_else(|| now_ms() + 12 * 60 * 60_000)
}

/// 「设置」二级子菜单：通用开关直接勾选（数值类除待处理条数单选外仍留在完整设置页）。
fn settings_submenu(settings: &TrayMenuSettings, lang: TrayLang) -> MenuEntry {
    let mut items = vec![
        check_item(
            ID_SET_CLOSE_TO_TRAY,
            tr(lang, Key::CloseToTray),
            settings.close_to_tray,
        ),
        MenuEntry::Separator,
        check_item(
            ID_SET_SHOW_STATUS,
            tr(lang, Key::ShowStatusCheck),
            settings.show_session_status,
        ),
        check_item(
            ID_SET_TOOLTIP_SUMMARY,
            tr(lang, Key::TooltipSummaryCheck),
            settings.tooltip_summary,
        ),
        check_item(
            ID_SET_CONFIRM_QUIT,
            tr(lang, Key::ConfirmQuitCheck),
            settings.confirm_quit,
        ),
        MenuEntry::Separator,
    ];
    for option in MAX_PENDING_OPTIONS {
        items.push(check_item(
            &format!("{MAX_PENDING_ID_PREFIX}{option}"),
            &max_pending_label(option, lang),
            settings.max_pending_entries == option,
        ));
    }
    items.push(MenuEntry::Separator);
    items.push(action_item(
        ID_OPEN_SETTINGS,
        tr(lang, Key::OpenFullSettings),
    ));
    MenuEntry::Submenu {
        id: ID_SETTINGS_SUBMENU.to_string(),
        text: tr(lang, Key::Settings).to_string(),
        items,
    }
}

fn max_pending_label(option: u8, lang: TrayLang) -> String {
    match lang {
        TrayLang::ZhCn => format!("待处理显示 {option} 条"),
        TrayLang::En => format!("Show {option} pending"),
    }
}

/// 「暂停所有提醒」二级子菜单：时长档不记勾选（起算时刻不持久），
/// 「直到手动恢复」勾选 = 永久暂停中；父项文案带剩余时长/已暂停后缀。
fn pause_submenu(snapshot: &TraySnapshot, lang: TrayLang) -> MenuEntry {
    let now = snapshot.now_ms;
    let paused = snapshot.paused_until.is_some_and(|until| until > now);
    let base = tr(lang, Key::PauseSubmenu);
    let text = match snapshot.paused_until {
        Some(u64::MAX) => format!("{base}（{}）", tr(lang, Key::PausedSuffix)),
        Some(until) if until > now => match lang {
            TrayLang::ZhCn => format!("{base}（剩 {}）", duration_text(until - now, lang)),
            TrayLang::En => format!("{base} ({} left)", duration_text(until - now, lang)),
        },
        _ => base.to_string(),
    };
    MenuEntry::Submenu {
        id: ID_PAUSE_SUBMENU.to_string(),
        text,
        items: vec![
            check_item(ID_PAUSE_15MIN, tr(lang, Key::Pause15Min), false),
            check_item(ID_PAUSE_1HOUR, tr(lang, Key::Pause1Hour), false),
            check_item(ID_PAUSE_TODAY, tr(lang, Key::PauseToday), false),
            check_item(
                ID_PAUSE_INDEFINITE,
                tr(lang, Key::PauseIndefinite),
                snapshot.paused_until == Some(u64::MAX),
            ),
            MenuEntry::Separator,
            MenuEntry::Item {
                id: ID_PAUSE_RESUME.to_string(),
                text: tr(lang, Key::PauseResume).to_string(),
                enabled: paused,
            },
        ],
    }
}

/// 「切换工作区」二级子菜单（快照已按新近程度截断）。
fn workspace_submenu(snapshot: &TraySnapshot, lang: TrayLang) -> MenuEntry {
    MenuEntry::Submenu {
        id: ID_WORKSPACE_SUBMENU.to_string(),
        text: tr(lang, Key::WorkspaceSubmenu).to_string(),
        items: snapshot
            .workspaces
            .iter()
            .map(|workspace| MenuEntry::Item {
                id: format!("{WORKSPACE_ID_PREFIX}{}", workspace.id),
                text: workspace.name.chars().take(MAX_NAME_CHARS).collect(),
                enabled: true,
            })
            .collect(),
    }
}

// ---------- Tauri 薄控制器 ----------

pub struct TrayMenuController {
    app: AppHandle,
    tray: TrayIcon,
    settings: Arc<SettingsService>,
    backend_state: Arc<TerminalBackendState>,
    orchestrator: Arc<OrchestratorService>,
    task_bindings: Arc<TaskBindingService>,
    workspaces: Arc<WorkspaceService>,
    prefs: Arc<NotificationPreferenceService>,
    language_override: Mutex<Option<String>>,
    last_refresh: Mutex<Instant>,
    trailing_scheduled: AtomicBool,
}

impl TrayMenuController {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        app: AppHandle,
        tray: TrayIcon,
        settings: Arc<SettingsService>,
        backend_state: Arc<TerminalBackendState>,
        orchestrator: Arc<OrchestratorService>,
        task_bindings: Arc<TaskBindingService>,
        workspaces: Arc<WorkspaceService>,
        prefs: Arc<NotificationPreferenceService>,
    ) -> Self {
        Self {
            app,
            tray,
            settings,
            backend_state,
            orchestrator,
            task_bindings,
            workspaces,
            prefs,
            language_override: Mutex::new(None),
            // 以「已过节流窗」初始化，首次 refresh 立即生效。
            last_refresh: Mutex::new(Instant::now() - REFRESH_THROTTLE),
            trailing_scheduled: AtomicBool::new(false),
        }
    }

    /// 首个菜单的 spec（托盘 build 前调用）。
    pub fn initial_spec(&self) -> MenuSpec {
        self.current_spec()
    }

    /// 300ms 节流刷新：窗口内首次调用立即重建，其余合并为一次尾随重建。
    pub fn refresh(self: &Arc<Self>) {
        let mut last = self.last_refresh.lock().unwrap_or_else(|e| e.into_inner());
        let elapsed = last.elapsed();
        if elapsed >= REFRESH_THROTTLE {
            *last = Instant::now();
            drop(last);
            self.rebuild();
        } else if !self.trailing_scheduled.swap(true, Ordering::SeqCst) {
            let delay = REFRESH_THROTTLE - elapsed;
            drop(last);
            let this = Arc::clone(self);
            std::thread::spawn(move || {
                std::thread::sleep(delay);
                this.trailing_scheduled.store(false, Ordering::SeqCst);
                *this.last_refresh.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
                this.rebuild();
            });
        }
    }

    /// 前端启动时推送语言（settings.general.language 为空时的兜底；优先读 settings）。
    pub fn set_language_override(self: &Arc<Self>, language: Option<String>) {
        *self
            .language_override
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = language.filter(|value| !value.trim().is_empty());
        self.refresh();
    }

    pub fn handle_menu_event(self: &Arc<Self>, id: &str) {
        if let Some(session_id) = id.strip_prefix(PENDING_ID_PREFIX) {
            self.show_main_window();
            self.emit_action(json!({"action": "focus-session", "sessionId": session_id}));
            return;
        }
        if let Some(workspace_id) = id.strip_prefix(WORKSPACE_ID_PREFIX) {
            self.show_main_window();
            self.emit_action(json!({"action": "switch-workspace", "workspaceId": workspace_id}));
            return;
        }
        if let Some(raw) = id.strip_prefix(MAX_PENDING_ID_PREFIX) {
            match raw.parse::<u8>() {
                Ok(value) => self.update_general(|g| g.tray_max_pending_entries = value),
                Err(error) => warn!(%error, id, "[tray] bad max-pending menu id"),
            }
            return;
        }
        match id {
            ID_SUMMARY | ID_SHOW_WINDOW => self.show_main_window(),
            ID_NEW_SESSION => {
                self.show_main_window();
                self.emit_action(json!({"action": "new-session"}));
            }
            ID_SCREENSHOT => crate::trigger_screenshot(&self.app, self.settings.clone()),
            ID_PAUSE_15MIN => self.pause_for(now_ms() + 15 * 60_000),
            ID_PAUSE_1HOUR => self.pause_for(now_ms() + 60 * 60_000),
            ID_PAUSE_TODAY => self.pause_for(end_of_today_ms()),
            ID_PAUSE_INDEFINITE => self.pause_for(u64::MAX),
            ID_PAUSE_RESUME => self.pause_resume(),
            ID_MUTE_SOUND => self.toggle_mute(),
            ID_SET_CLOSE_TO_TRAY => self.update_general(|g| g.close_to_tray = !g.close_to_tray),
            ID_SET_SHOW_STATUS => {
                self.update_general(|g| g.tray_show_session_status = !g.tray_show_session_status)
            }
            ID_SET_TOOLTIP_SUMMARY => {
                self.update_general(|g| g.tray_tooltip_summary = !g.tray_tooltip_summary)
            }
            ID_SET_CONFIRM_QUIT => {
                self.update_general(|g| g.tray_confirm_quit = !g.tray_confirm_quit)
            }
            ID_CHECK_UPDATES => {
                self.show_main_window();
                self.emit_action(json!({"action": "check-updates"}));
            }
            ID_OPEN_SETTINGS => {
                self.show_main_window();
                self.emit_action(json!({"action": "open-settings", "section": "tray"}));
            }
            ID_QUIT => self.quit(),
            _ => {}
        }
    }

    fn rebuild(&self) {
        let spec = self.current_spec();
        self.apply_spec(&spec);
    }

    fn current_spec(&self) -> MenuSpec {
        let snapshot = self.collect_snapshot();
        let general = self.settings.get_settings().general;
        let settings = TrayMenuSettings {
            show_session_status: general.tray_show_session_status,
            max_pending_entries: general.tray_max_pending_entries,
            tooltip_summary: general.tray_tooltip_summary,
            confirm_quit: general.tray_confirm_quit,
            close_to_tray: general.close_to_tray,
        };
        build_menu_spec(&snapshot, &settings, self.effective_lang())
    }

    /// 会话快照数据源：与 `get_all_terminal_status` 命令同一路径
    /// （backend 枚举 + 状态机校正），会话名只对待处理会话查 TaskBinding。
    fn collect_snapshot(&self) -> TraySnapshot {
        let now = now_ms();
        let prefs = self.prefs.get();
        let mut statuses = self
            .backend_state
            .backend()
            .get_all_status()
            .unwrap_or_default();
        self.orchestrator
            .adjust_terminal_statuses_for_query(&mut statuses);
        let sessions = statuses
            .into_iter()
            .map(|info| self.session_entry(info))
            .collect();
        TraySnapshot {
            sessions,
            paused_until: prefs.global_pause_until,
            sound_muted: prefs.sound_muted,
            workspaces: self.workspace_entries(),
            now_ms: now,
        }
    }

    /// 工作区快照：created_at 倒序取前 5（模型无最近使用时间，最新创建即最近）。
    fn workspace_entries(&self) -> Vec<TrayWorkspaceEntry> {
        let mut list = self.workspaces.list_workspaces().unwrap_or_default();
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        list.truncate(5);
        list.into_iter()
            .map(|workspace| TrayWorkspaceEntry {
                id: workspace.id,
                name: workspace
                    .alias
                    .filter(|alias| !alias.trim().is_empty())
                    .unwrap_or(workspace.name),
            })
            .collect()
    }

    fn session_entry(
        &self,
        info: cc_panes_core::services::terminal_service::SessionStatusInfo,
    ) -> TraySessionEntry {
        let pending = matches!(
            info.status,
            SessionStatus::WaitingInput | SessionStatus::Error
        );
        TraySessionEntry {
            name: if pending {
                self.session_name(&info.session_id)
            } else {
                String::new()
            },
            session_id: info.session_id,
            status: info.status,
            status_since_ms: info.updated_at,
        }
    }

    /// 会话显示名：TaskBinding 标题优先，查不到回退空串（纯函数侧再用 id 短码兜底）。
    fn session_name(&self, session_id: &str) -> String {
        match self.task_bindings.find_by_session_id(session_id) {
            Ok(Some(binding)) => binding.title,
            Ok(None) => String::new(),
            Err(error) => {
                warn!(%error, session_id, "[tray] session name lookup failed");
                String::new()
            }
        }
    }

    fn effective_lang(&self) -> TrayLang {
        let from_settings = self.settings.get_settings().general.language;
        if !from_settings.trim().is_empty() {
            return resolve_lang(&from_settings);
        }
        self.language_override
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_deref()
            .map(resolve_lang)
            .unwrap_or(TrayLang::ZhCn)
    }

    fn apply_spec(&self, spec: &MenuSpec) {
        match build_native_menu(&self.app, spec) {
            Ok(menu) => {
                if let Err(error) = self.tray.set_menu(Some(menu)) {
                    warn!(%error, "[tray] set_menu failed");
                }
            }
            Err(error) => warn!(%error, "[tray] menu build failed"),
        }
        if let Err(error) = self.tray.set_tooltip(Some(self.tooltip_text(spec))) {
            warn!(%error, "[tray] set_tooltip failed");
        }
    }

    /// dev/release 区分保留：摘要模式下前缀仍带 [DEV]。
    fn tooltip_text(&self, spec: &MenuSpec) -> String {
        let base = if cfg!(debug_assertions) {
            "CC-Panes [DEV]"
        } else {
            "CC-Panes"
        };
        match &spec.tooltip_summary {
            Some(summary) => format!("{base}\n{summary}"),
            None => base.to_string(),
        }
    }

    fn show_main_window(&self) {
        // 截图期间不恢复窗口，避免窗口重新出现在截图中
        if crate::CAPTURING.load(Ordering::SeqCst) {
            return;
        }
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }

    fn toggle_mute(self: &Arc<Self>) {
        let muted = self.prefs.sound_muted();
        match self.prefs.set_sound_muted(!muted) {
            Ok(prefs) => self.emit_prefs_changed(&prefs),
            Err(error) => warn!(%error, "[tray] failed to persist sound mute"),
        }
        self.refresh();
    }

    /// 暂停所有提醒到指定截止（u64::MAX = 直到手动恢复）。
    fn pause_for(self: &Arc<Self>, until: u64) {
        match self.prefs.set_global_pause_until(Some(until)) {
            Ok(prefs) => self.emit_prefs_changed(&prefs),
            Err(error) => warn!(%error, "[tray] failed to persist global pause"),
        }
        self.refresh();
    }

    fn pause_resume(self: &Arc<Self>) {
        match self.prefs.set_global_pause_until(None) {
            Ok(prefs) => self.emit_prefs_changed(&prefs),
            Err(error) => warn!(%error, "[tray] failed to clear global pause"),
        }
        self.refresh();
    }

    /// 设置子菜单项：整份读改写（与前端 update_settings 同通道），广播后重建菜单。
    fn update_general(self: &Arc<Self>, mutate: impl FnOnce(&mut GeneralSettings)) {
        let mut settings = self.settings.get_settings();
        mutate(&mut settings.general);
        if let Err(error) = self.settings.update_settings(settings) {
            warn!(%error, "[tray] failed to persist settings toggle");
            return;
        }
        if let Err(error) = self.app.emit(SETTINGS_CHANGED_EVENT, ()) {
            warn!(%error, "[tray] failed to emit settings-changed");
        }
        self.refresh();
    }

    fn quit(&self) {
        let spec = self.current_spec();
        if spec.quit_needs_confirm {
            self.show_main_window();
            self.emit_action(json!({
                "action": "confirm-quit",
                "runningCount": spec.running_sessions,
            }));
        } else {
            self.app.exit(0);
        }
    }

    fn emit_action(&self, payload: serde_json::Value) {
        if let Err(error) = self.app.emit(TRAY_ACTION_EVENT, payload) {
            warn!(%error, "[tray] failed to emit tray-action");
        }
    }

    fn emit_prefs_changed(
        &self,
        prefs: &crate::services::notification_preferences::NotificationPreferences,
    ) {
        if let Err(error) = self.app.emit(PREFS_CHANGED_EVENT, prefs) {
            warn!(%error, "[tray] failed to emit preferences change");
        }
    }
}

/// spec → 原生菜单（薄转换层，无决策逻辑）。
fn build_native_menu(app: &AppHandle, spec: &MenuSpec) -> tauri::Result<Menu<Wry>> {
    let mut items: Vec<MenuItemKind<Wry>> = Vec::with_capacity(spec.entries.len());
    for entry in &spec.entries {
        items.push(native_item(app, entry)?);
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(kind_ref).collect();
    Menu::with_items(app, &refs)
}

fn kind_ref(kind: &MenuItemKind<Wry>) -> &dyn IsMenuItem<Wry> {
    match kind {
        MenuItemKind::MenuItem(item) => item,
        MenuItemKind::Check(item) => item,
        MenuItemKind::Predefined(item) => item,
        MenuItemKind::Submenu(item) => item,
        MenuItemKind::Icon(item) => item,
    }
}

fn native_item(app: &AppHandle, entry: &MenuEntry) -> tauri::Result<MenuItemKind<Wry>> {
    Ok(match entry {
        MenuEntry::Item { id, text, enabled } => {
            MenuItemKind::MenuItem(MenuItem::with_id(app, id, text, *enabled, None::<&str>)?)
        }
        MenuEntry::CheckItem { id, text, checked } => MenuItemKind::Check(CheckMenuItem::with_id(
            app,
            id,
            text,
            true,
            *checked,
            None::<&str>,
        )?),
        MenuEntry::Submenu { id, text, items } => {
            let mut children: Vec<MenuItemKind<Wry>> = Vec::with_capacity(items.len());
            for child in items {
                children.push(native_item(app, child)?);
            }
            let refs: Vec<&dyn IsMenuItem<Wry>> = children.iter().map(kind_ref).collect();
            MenuItemKind::Submenu(Submenu::with_id_and_items(app, id, text, true, &refs)?)
        }
        MenuEntry::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
    })
}
