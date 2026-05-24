use crate::services::{SettingsService, TaskBindingService};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRequest {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub dedupe_key: Option<String>,
    #[serde(default)]
    pub group_key: Option<String>,
    #[serde(default)]
    pub only_when_unfocused: Option<bool>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTriggerResult {
    pub sent: bool,
    pub skipped: bool,
    pub reason: Option<String>,
}

impl NotificationTriggerResult {
    fn sent() -> Self {
        Self {
            sent: true,
            skipped: false,
            reason: None,
        }
    }

    fn skipped(reason: impl Into<String>) -> Self {
        Self {
            sent: false,
            skipped: true,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone)]
struct PreparedNotificationRequest {
    kind: String,
    title: String,
    body: Option<String>,
    source: Option<String>,
    scope: Option<String>,
    dedupe_key: Option<String>,
    group_key: Option<String>,
    only_when_unfocused: Option<bool>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy)]
struct NotificationSentEvent<'a> {
    kind: &'a str,
    title: &'a str,
    body: Option<&'a str>,
    source: Option<&'a str>,
    scope: Option<&'a str>,
    dedupe_key: Option<&'a str>,
    group_key: Option<&'a str>,
}

/// 通知服务 - 管理显式触发的桌面通知与去重
pub struct NotificationService {
    recent_notifications: Mutex<HashMap<String, Instant>>,
    dedupe_secs: u64,
}

impl NotificationService {
    pub fn new() -> Self {
        Self {
            recent_notifications: Mutex::new(HashMap::new()),
            dedupe_secs: 10,
        }
    }

    pub fn trigger(
        &self,
        app: &AppHandle,
        settings_svc: &Arc<SettingsService>,
        request: NotificationRequest,
    ) -> Result<NotificationTriggerResult, String> {
        let request = Self::normalize_request(request)?;
        let settings = settings_svc.get_settings().notification;
        if !settings.enabled {
            return Ok(NotificationTriggerResult::skipped("notifications_disabled"));
        }

        let only_when_unfocused = request
            .only_when_unfocused
            .unwrap_or(settings.only_when_unfocused);
        if only_when_unfocused && self.is_window_focused(app) {
            return Ok(NotificationTriggerResult::skipped("window_focused"));
        }

        if let Some(ref dedupe_key) = request.dedupe_key {
            if !self.check_dedupe(dedupe_key) {
                return Ok(NotificationTriggerResult::skipped("deduped"));
            }
        }

        info!(
            kind = %request.kind,
            title = %request.title,
            source = request.source.as_deref().unwrap_or("unknown"),
            scope = request.scope.as_deref().unwrap_or("global"),
            metadata = request.metadata.as_ref().map(|m| m.to_string()).unwrap_or_default(),
            "notification::trigger"
        );

        self.send_notification(app, &request.title, request.body.as_deref())?;
        self.emit_notification_sent(
            app,
            NotificationSentEvent {
                kind: &request.kind,
                title: &request.title,
                body: request.body.as_deref(),
                source: request.source.as_deref(),
                scope: request.scope.as_deref(),
                dedupe_key: request.dedupe_key.as_deref(),
                group_key: request.group_key.as_deref(),
            },
        );
        Ok(NotificationTriggerResult::sent())
    }

    /// 会话退出通知
    pub fn notify_session_exited(
        &self,
        app: &AppHandle,
        settings_svc: &Arc<SettingsService>,
        session_id: &str,
        exit_code: i32,
        group_key: Option<String>,
    ) {
        let settings = settings_svc.get_settings().notification;
        if !settings.enabled || !settings.on_exit {
            return;
        }
        if settings.only_when_unfocused && self.is_window_focused(app) {
            return;
        }
        if self.is_task_muted(app, session_id) {
            return;
        }
        if !self.check_dedupe(&format!("session_exit:{session_id}")) {
            return;
        }

        let body = if exit_code == 0 {
            "Session exited normally"
        } else {
            "Session exited with an error"
        };
        if self
            .send_notification(app, "Session Exited", Some(body))
            .is_ok()
        {
            self.emit_notification_sent(
                app,
                NotificationSentEvent {
                    kind: "session_exited",
                    title: "Session Exited",
                    body: Some(body),
                    source: Some("terminal"),
                    scope: Some("session"),
                    dedupe_key: Some(&format!("session_exit:{session_id}")),
                    group_key: group_key.as_deref(),
                },
            );
        }
    }

    /// 等待输入通知
    pub fn notify_waiting_input(
        &self,
        app: &AppHandle,
        settings_svc: &Arc<SettingsService>,
        session_id: &str,
        group_key: Option<String>,
    ) {
        let settings = settings_svc.get_settings().notification;
        if !settings.enabled || !settings.on_waiting_input {
            return;
        }
        if settings.only_when_unfocused && self.is_window_focused(app) {
            return;
        }
        if self.is_task_muted(app, session_id) {
            return;
        }
        if !self.check_dedupe(&format!("session_waiting_input:{session_id}")) {
            return;
        }

        if self
            .send_notification(
                app,
                "Action Required",
                Some("Terminal is waiting for input confirmation"),
            )
            .is_ok()
        {
            self.emit_notification_sent(
                app,
                NotificationSentEvent {
                    kind: "waiting_input",
                    title: "Action Required",
                    body: Some("Terminal is waiting for input confirmation"),
                    source: Some("terminal"),
                    scope: Some("session"),
                    dedupe_key: Some(&format!("session_waiting_input:{session_id}")),
                    group_key: group_key.as_deref(),
                },
            );
        }
    }

    /// 清理与该会话相关的去重记录
    pub fn cleanup_session(&self, session_id: &str) {
        let mut map = self
            .recent_notifications
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.remove(&format!("session_exit:{session_id}"));
        map.remove(&format!("session_waiting_input:{session_id}"));
    }

    // ============ 阶段 2.6：hook 状态机驱动的新通知 ============
    //
    // 这三个方法被 SessionStateMachine 在状态跃迁时调用：
    //   - notify_turn_end → TurnEnd（→ Idle）："✅ 完成"
    //   - notify_error    → Error 跃迁："❗ <error_type>"
    //   - notify_slow_tool→ ToolRunning ≥ 60s（由 2.7 长工具 timer 调用）
    //
    // 通用规则：尊重 settings.enabled / only_when_unfocused / dedupe。
    // 复用相同的 `on_waiting_input` settings 开关（用户层面"等输入"和"完成"
    // 都属于"agent 需要你的注意"），未来如需细分再拆。

    pub fn notify_turn_end(
        &self,
        app: &AppHandle,
        settings_svc: &Arc<SettingsService>,
        session_id: &str,
        turn_seq: u64,
        summary: Option<&str>,
        group_key: Option<String>,
    ) {
        let settings = settings_svc.get_settings().notification;
        if !settings.enabled || !settings.on_waiting_input {
            return;
        }
        if settings.only_when_unfocused && self.is_window_focused(app) {
            return;
        }
        if self.is_task_muted(app, session_id) {
            return;
        }
        let dedupe_key = format!("turn_end:{session_id}:{turn_seq}");
        if !self.check_dedupe(&dedupe_key) {
            return;
        }
        let body_owned = summary
            .map(|s| s.chars().take(80).collect::<String>())
            .unwrap_or_else(|| "Claude finished this turn".to_string());
        if self
            .send_notification(app, "✅ Completed", Some(&body_owned))
            .is_ok()
        {
            self.emit_notification_sent(
                app,
                NotificationSentEvent {
                    kind: "turn_end",
                    title: "✅ Completed",
                    body: Some(&body_owned),
                    source: Some("hook"),
                    scope: Some("session"),
                    dedupe_key: Some(&dedupe_key),
                    group_key: group_key.as_deref(),
                },
            );
        }
    }

    pub fn notify_error(
        &self,
        app: &AppHandle,
        settings_svc: &Arc<SettingsService>,
        session_id: &str,
        error_type: Option<&str>,
        group_key: Option<String>,
    ) {
        let settings = settings_svc.get_settings().notification;
        if !settings.enabled || !settings.on_exit {
            return;
        }
        if settings.only_when_unfocused && self.is_window_focused(app) {
            return;
        }
        if self.is_task_muted(app, session_id) {
            return;
        }
        let etype = error_type.unwrap_or("unknown");
        let dedupe_key = format!("error:{session_id}:{etype}");
        if !self.check_dedupe(&dedupe_key) {
            return;
        }
        let body = format!("Error: {}", etype);
        if self.send_notification(app, "❗ Error", Some(&body)).is_ok() {
            self.emit_notification_sent(
                app,
                NotificationSentEvent {
                    kind: "error",
                    title: "❗ Error",
                    body: Some(&body),
                    source: Some("hook"),
                    scope: Some("session"),
                    dedupe_key: Some(&dedupe_key),
                    group_key: group_key.as_deref(),
                },
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn notify_slow_tool(
        &self,
        app: &AppHandle,
        settings_svc: &Arc<SettingsService>,
        session_id: &str,
        tool_name: &str,
        tool_use_id: Option<&str>,
        seconds: u64,
        group_key: Option<String>,
    ) {
        let settings = settings_svc.get_settings().notification;
        if !settings.enabled || !settings.on_waiting_input {
            return;
        }
        if settings.only_when_unfocused && self.is_window_focused(app) {
            return;
        }
        if self.is_task_muted(app, session_id) {
            return;
        }
        let suffix = tool_use_id.unwrap_or("none");
        let dedupe_key = format!("slow:{session_id}:{suffix}");
        if !self.check_dedupe(&dedupe_key) {
            return;
        }
        let body = format!("{} has been running for {}s", tool_name, seconds);
        if self
            .send_notification(app, "⏱ Tool Running", Some(&body))
            .is_ok()
        {
            self.emit_notification_sent(
                app,
                NotificationSentEvent {
                    kind: "slow_tool",
                    title: "⏱ Tool Running",
                    body: Some(&body),
                    source: Some("hook"),
                    scope: Some("session"),
                    dedupe_key: Some(&dedupe_key),
                    group_key: group_key.as_deref(),
                },
            );
        }
    }

    fn normalize_request(
        request: NotificationRequest,
    ) -> Result<PreparedNotificationRequest, String> {
        let kind = request.kind.trim();
        if kind.is_empty() {
            return Err("Notification kind cannot be empty".to_string());
        }

        let title = request.title.trim();
        let body = request
            .body
            .map(|body| body.trim().to_string())
            .filter(|body| !body.is_empty());

        if title.is_empty() && body.is_none() {
            return Err("Notification title or body is required".to_string());
        }

        let title = if title.is_empty() {
            kind.to_string()
        } else {
            title.to_string()
        };

        Ok(PreparedNotificationRequest {
            kind: kind.to_string(),
            title,
            body,
            source: request
                .source
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            scope: request
                .scope
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            dedupe_key: request
                .dedupe_key
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            group_key: request
                .group_key
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            only_when_unfocused: request.only_when_unfocused,
            metadata: request.metadata,
        })
    }

    fn is_window_focused(&self, app: &AppHandle) -> bool {
        app.get_webview_window("main")
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false)
    }

    fn check_dedupe(&self, dedupe_key: &str) -> bool {
        let mut map = self
            .recent_notifications
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(last) = map.get(dedupe_key) {
            if last.elapsed().as_secs() < self.dedupe_secs {
                return false;
            }
        }
        map.insert(dedupe_key.to_string(), Instant::now());
        true
    }

    fn is_task_muted(&self, app: &AppHandle, session_id: &str) -> bool {
        let Some(task_binding_service) = app.try_state::<Arc<TaskBindingService>>() else {
            return false;
        };

        match task_binding_service.find_by_session_id(session_id) {
            Ok(Some(binding)) => task_metadata_muted(&binding.metadata),
            Ok(None) => false,
            Err(error) => {
                warn!(
                    session_id = %session_id,
                    err = %error,
                    "Failed to load TaskBinding notification metadata; continuing notification"
                );
                false
            }
        }
    }

    fn send_notification(
        &self,
        app: &AppHandle,
        title: &str,
        body: Option<&str>,
    ) -> Result<(), String> {
        let mut builder = app.notification().builder().title(title);
        if let Some(body) = body {
            builder = builder.body(body);
        }
        builder
            .show()
            .map_err(|e| format!("Failed to show desktop notification: {}", e))
    }

    fn emit_notification_sent(&self, app: &AppHandle, event: NotificationSentEvent<'_>) {
        let _ = app.emit(
            "notification-sent",
            serde_json::json!({
                "kind": event.kind,
                "title": event.title,
                "body": event.body,
                "source": event.source,
                "scope": event.scope,
                "dedupeKey": event.dedupe_key,
                "groupKey": event.group_key,
            }),
        );
    }
}

fn task_metadata_muted(metadata: &Option<serde_json::Value>) -> bool {
    metadata
        .as_ref()
        .and_then(|metadata| metadata.get("ui"))
        .and_then(|ui| ui.get("muted"))
        .and_then(|muted| muted.as_bool())
        == Some(true)
}

impl Default for NotificationService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_request_trims_and_keeps_optional_fields() {
        let normalized = NotificationService::normalize_request(NotificationRequest {
            kind: " task_completed ".to_string(),
            title: "  Finished  ".to_string(),
            body: Some("  Task done  ".to_string()),
            source: Some(" cli ".to_string()),
            scope: Some(" project ".to_string()),
            dedupe_key: Some(" session:123 ".to_string()),
            group_key: Some(" group:1 ".to_string()),
            only_when_unfocused: Some(true),
            metadata: Some(serde_json::json!({ "taskId": "1" })),
        })
        .expect("request should be valid");

        assert_eq!(normalized.kind, "task_completed");
        assert_eq!(normalized.title, "Finished");
        assert_eq!(normalized.body.as_deref(), Some("Task done"));
        assert_eq!(normalized.source.as_deref(), Some("cli"));
        assert_eq!(normalized.scope.as_deref(), Some("project"));
        assert_eq!(normalized.dedupe_key.as_deref(), Some("session:123"));
        assert_eq!(normalized.group_key.as_deref(), Some("group:1"));
        assert_eq!(normalized.only_when_unfocused, Some(true));
    }

    #[test]
    fn normalize_request_requires_content() {
        let result = NotificationService::normalize_request(NotificationRequest {
            kind: "custom".to_string(),
            title: "   ".to_string(),
            body: Some("   ".to_string()),
            source: None,
            scope: None,
            dedupe_key: None,
            group_key: None,
            only_when_unfocused: None,
            metadata: None,
        });
        assert!(result.is_err());
    }

    #[test]
    fn check_dedupe_blocks_repeated_key() {
        let service = NotificationService::new();
        assert!(service.check_dedupe("session:1"));
        assert!(!service.check_dedupe("session:1"));
        assert!(service.check_dedupe("session:2"));
    }

    #[test]
    fn task_metadata_muted_only_skips_explicit_true() {
        assert!(task_metadata_muted(&Some(serde_json::json!({
            "ui": { "muted": true }
        }))));
        assert!(!task_metadata_muted(&Some(serde_json::json!({
            "ui": { "muted": false }
        }))));
        assert!(!task_metadata_muted(&Some(serde_json::json!({
            "ui": { "muted": "true" }
        }))));
        assert!(!task_metadata_muted(&None));
    }
}
