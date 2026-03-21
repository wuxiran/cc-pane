use crate::services::SettingsService;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

/// 通知服务 - 管理桌面通知的发送与防抖
pub struct NotificationService {
    last_notified: Mutex<HashMap<String, Instant>>,
    debounce_secs: u64,
}

impl NotificationService {
    pub fn new() -> Self {
        Self {
            last_notified: Mutex::new(HashMap::new()),
            debounce_secs: 10,
        }
    }

    /// 会话退出通知
    pub fn notify_session_exited(
        &self,
        app: &AppHandle,
        settings_svc: &Arc<SettingsService>,
        session_id: &str,
        exit_code: i32,
    ) {
        let settings = settings_svc.get_settings().notification;
        if !settings.enabled || !settings.on_exit {
            return;
        }
        if settings.only_when_unfocused && self.is_window_focused(app) {
            return;
        }
        if !self.check_debounce(session_id) {
            return;
        }

        let body = if exit_code == 0 {
            "Session exited normally".to_string()
        } else {
            format!("Session exited (exit code: {})", exit_code)
        };
        self.send_notification(app, "Session Exited", &body);
    }

    /// 等待输入通知
    pub fn notify_waiting_input(
        &self,
        app: &AppHandle,
        settings_svc: &Arc<SettingsService>,
        session_id: &str,
    ) {
        let settings = settings_svc.get_settings().notification;
        if !settings.enabled || !settings.on_waiting_input {
            return;
        }
        if settings.only_when_unfocused && self.is_window_focused(app) {
            return;
        }
        if !self.check_debounce(session_id) {
            return;
        }

        self.send_notification(
            app,
            "Action Required",
            "Terminal is waiting for input confirmation",
        );
    }

    /// 检查窗口是否处于聚焦状态
    fn is_window_focused(&self, app: &AppHandle) -> bool {
        app.get_webview_window("main")
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false)
    }

    /// 防抖检查：同一 session 在 debounce_secs 秒内不重复通知
    /// 返回 true 表示可以发送
    fn check_debounce(&self, session_id: &str) -> bool {
        let mut map = self.last_notified.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(last) = map.get(session_id) {
            if last.elapsed().as_secs() < self.debounce_secs {
                return false;
            }
        }
        map.insert(session_id.to_string(), Instant::now());
        true
    }

    /// 发送桌面通知
    fn send_notification(&self, app: &AppHandle, title: &str, body: &str) {
        let _ = app.notification().builder().title(title).body(body).show();
    }

    /// Todo 提醒通知
    pub fn notify_todo_reminder(&self, app: &AppHandle, todo_id: &str, title: &str) {
        if !self.check_debounce(&format!("todo_reminder_{}", todo_id)) {
            return;
        }
        self.send_notification(app, "Todo Reminder", title);
    }

    /// 清理防抖记录（会话关闭时调用）
    pub fn cleanup_session(&self, session_id: &str) {
        let mut map = self.last_notified.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(session_id);
    }
}

impl Default for NotificationService {
    fn default() -> Self {
        Self::new()
    }
}
