use serde_json::Value;

/// Framework-independent event emitter trait.
/// Tauri adapter implements this with `AppHandle.emit()`.
/// Future HTTP adapter can implement this with WebSocket broadcast.
pub trait EventEmitter: Send + Sync {
    fn emit(&self, event: &str, payload: Value) -> anyhow::Result<()>;
}

/// No-op emitter for testing or headless mode
pub struct NoopEmitter;

impl EventEmitter for NoopEmitter {
    fn emit(&self, _event: &str, _payload: Value) -> anyhow::Result<()> {
        Ok(())
    }
}

/// Session notification trait (decouples from Tauri notification plugin).
/// TerminalService uses this to trigger desktop notifications.
pub trait SessionNotifier: Send + Sync {
    fn notify_waiting_input(&self, session_id: &str);
    fn notify_session_exited(&self, session_id: &str, exit_code: i32);
    fn cleanup_session(&self, session_id: &str);
}

/// No-op notifier for testing or headless mode
pub struct NoopNotifier;

impl SessionNotifier for NoopNotifier {
    fn notify_waiting_input(&self, _session_id: &str) {}
    fn notify_session_exited(&self, _session_id: &str, _exit_code: i32) {}
    fn cleanup_session(&self, _session_id: &str) {}
}
