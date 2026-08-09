use crate::services::{SettingsService, TaskBindingService, TurnNotifyRegistry};
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
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub requires_input: Option<bool>,
    #[serde(default)]
    pub input_placeholder: Option<String>,
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
    session_id: Option<String>,
    requires_input: Option<bool>,
    input_placeholder: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
struct NotificationSentEvent<'a> {
    kind: &'a str,
    title: &'a str,
    body: Option<&'a str>,
    source: Option<&'a str>,
    scope: Option<&'a str>,
    dedupe_key: Option<&'a str>,
    group_key: Option<&'a str>,
    metadata: Option<&'a serde_json::Value>,
    session_id: Option<&'a str>,
    requires_input: Option<bool>,
    input_placeholder: Option<&'a str>,
}

/// 通知服务 - 管理显式触发的桌面通知与去重
pub struct NotificationService {
    recent_notifications: Mutex<HashMap<String, Instant>>,
    dedupe_secs: u64,
    /// 「本轮已富通知」标记注册表（与状态机 turn_end 兜底共享，见 turn_notify_registry.rs）
    turn_notify: Arc<TurnNotifyRegistry>,
}

impl NotificationService {
    pub fn new(turn_notify: Arc<TurnNotifyRegistry>) -> Self {
        Self {
            recent_notifications: Mutex::new(HashMap::new()),
            dedupe_secs: 10,
            turn_notify,
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
                metadata: request.metadata.as_ref(),
                session_id: request.session_id.as_deref(),
                requires_input: request.requires_input,
                input_placeholder: request.input_placeholder.as_deref(),
            },
        );
        self.mark_turn_notify_if_applicable(&request.kind, request.session_id.as_deref());
        Ok(NotificationTriggerResult::sent())
    }

    /// AI 富摘要通知（kind=turn_end + sessionId）实际送达后打「本轮已富通知」标记，
    /// 状态机 Idle 跃迁的桌面兜底据此跳过（orchestrator_service.rs 的 sync listener）。
    /// `im_forwarded` 本批恒 false：富通知尚未接 IM 转发（docs/88 批次2），
    /// IM 兜底因此不受此标记影响。
    fn mark_turn_notify_if_applicable(&self, kind: &str, session_id: Option<&str>) {
        if kind != "turn_end" {
            return;
        }
        if let Some(session_id) = session_id {
            self.turn_notify.mark(session_id, false);
        }
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
                    session_id: Some(session_id),
                    ..Default::default()
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
                    session_id: Some(session_id),
                    ..Default::default()
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
        drop(map);
        self.turn_notify.clear(session_id);
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
                    session_id: Some(session_id),
                    ..Default::default()
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
                    session_id: Some(session_id),
                    ..Default::default()
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
                    session_id: Some(session_id),
                    ..Default::default()
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
            session_id: request
                .session_id
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            requires_input: request.requires_input,
            input_placeholder: request
                .input_placeholder
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
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
        let _ = app.emit("notification-sent", build_notification_sent_payload(event));
    }
}

/// 前端 useNotificationStore 消费的完整 payload。
/// id/timestamp 由后端生成，前端不再自造（否则跨窗口同一条通知 id 不一致）。
fn build_notification_sent_payload(event: NotificationSentEvent<'_>) -> serde_json::Value {
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "timestamp": timestamp_ms,
        "kind": event.kind,
        "title": event.title,
        "body": event.body,
        "source": event.source,
        "scope": event.scope,
        "dedupeKey": event.dedupe_key,
        "groupKey": event.group_key,
        "metadata": event.metadata,
        "sessionId": event.session_id,
        "requiresInput": event.requires_input,
        "inputPlaceholder": event.input_placeholder,
    })
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
        Self::new(Arc::new(TurnNotifyRegistry::new()))
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
            session_id: Some(" term-abc ".to_string()),
            requires_input: Some(true),
            input_placeholder: Some(" 回复 yes/no ".to_string()),
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
        assert_eq!(normalized.session_id.as_deref(), Some("term-abc"));
        assert_eq!(normalized.requires_input, Some(true));
        assert_eq!(normalized.input_placeholder.as_deref(), Some("回复 yes/no"));
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
            session_id: None,
            requires_input: None,
            input_placeholder: None,
        });
        assert!(result.is_err());
    }

    #[test]
    fn notification_sent_payload_carries_identity_and_input_fields() {
        let metadata = serde_json::json!({ "taskBindingId": "tb-1" });
        let payload = build_notification_sent_payload(NotificationSentEvent {
            kind: "waiting_input",
            title: "Action Required",
            body: Some("body"),
            source: Some("terminal"),
            scope: Some("session"),
            dedupe_key: Some("session_waiting_input:term-1"),
            group_key: Some("g1"),
            metadata: Some(&metadata),
            session_id: Some("term-1"),
            requires_input: Some(true),
            input_placeholder: Some("回复…"),
        });

        assert!(!payload["id"].as_str().unwrap_or_default().is_empty());
        assert!(payload["timestamp"].as_u64().unwrap_or(0) > 0);
        assert_eq!(payload["sessionId"], "term-1");
        assert_eq!(payload["requiresInput"], true);
        assert_eq!(payload["inputPlaceholder"], "回复…");
        assert_eq!(payload["metadata"]["taskBindingId"], "tb-1");
    }

    #[test]
    fn notification_sent_payload_defaults_optional_fields_to_null() {
        let payload = build_notification_sent_payload(NotificationSentEvent {
            kind: "session_exited",
            title: "Session Exited",
            session_id: Some("term-2"),
            ..Default::default()
        });
        assert_eq!(payload["sessionId"], "term-2");
        assert!(payload["requiresInput"].is_null());
        assert!(payload["metadata"].is_null());
        assert!(payload["inputPlaceholder"].is_null());
    }

    #[test]
    fn check_dedupe_blocks_repeated_key() {
        let service = NotificationService::default();
        assert!(service.check_dedupe("session:1"));
        assert!(!service.check_dedupe("session:1"));
        assert!(service.check_dedupe("session:2"));
    }

    // 集成路径（trigger 打标 → 状态机 Idle 兜底查标 → 下一轮 clear 恢复）：
    // trigger/notify_turn_end 需要 AppHandle，这里对同一共享 registry 走
    // 与两个消费方完全相同的判定原语（mark_turn_notify_if_applicable / is_marked / clear）。
    #[test]
    fn turn_end_trigger_marks_registry_and_clear_restores_fallback() {
        let registry = Arc::new(TurnNotifyRegistry::new());
        let service = NotificationService::new(registry.clone());

        // trigger(turn_end + sessionId) 打标 → 桌面兜底（is_marked 命中）跳过
        service.mark_turn_notify_if_applicable("turn_end", Some("s1"));
        let mark = registry.is_marked("s1").expect("marked after rich notify");
        // 本批 IM 转发未接通，im_forwarded 恒 false → IM 兜底不跳过
        assert!(!mark.im_forwarded);

        // 未 trigger 的会话不受影响，兜底照发
        assert!(registry.is_marked("s2").is_none());

        // 下一轮（Idle→忙碌跃迁触发 clear）后兜底恢复
        registry.clear("s1");
        assert!(registry.is_marked("s1").is_none());

        // 非 turn_end kind / 缺 sessionId 都不打标
        service.mark_turn_notify_if_applicable("error", Some("s3"));
        service.mark_turn_notify_if_applicable("turn_end", None);
        assert!(registry.is_marked("s3").is_none());
    }

    #[test]
    fn cleanup_session_clears_turn_notify_mark() {
        let registry = Arc::new(TurnNotifyRegistry::new());
        let service = NotificationService::new(registry.clone());
        service.mark_turn_notify_if_applicable("turn_end", Some("s1"));
        assert!(registry.is_marked("s1").is_some());
        service.cleanup_session("s1");
        assert!(registry.is_marked("s1").is_none());
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
