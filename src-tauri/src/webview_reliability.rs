use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(windows)]
use std::sync::{Mutex, OnceLock};

static WEBVIEW_EMITS_SUSPENDED: AtomicBool = AtomicBool::new(false);
static WEBVIEW_RECOVERY_HOLDS_EXIT: AtomicBool = AtomicBool::new(false);

pub(crate) fn webview_emits_allowed() -> bool {
    !WEBVIEW_EMITS_SUSPENDED.load(Ordering::Acquire)
}

pub(crate) fn webview_recovery_holds_exit() -> bool {
    WEBVIEW_RECOVERY_HOLDS_EXIT.load(Ordering::Acquire)
}

#[cfg(windows)]
fn suspend_webview_emits() {
    WEBVIEW_EMITS_SUSPENDED.store(true, Ordering::Release);
}

#[cfg(windows)]
fn resume_webview_emits() {
    WEBVIEW_EMITS_SUSPENDED.store(false, Ordering::Release);
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProcessFailureKind {
    BrowserProcessExited,
    RenderProcessExited,
    RenderProcessUnresponsive,
    Other(i32),
}

#[cfg(any(windows, test))]
impl ProcessFailureKind {
    #[cfg(windows)]
    fn from_raw(raw: i32) -> Self {
        match raw {
            0 => Self::BrowserProcessExited,
            1 => Self::RenderProcessExited,
            2 => Self::RenderProcessUnresponsive,
            other => Self::Other(other),
        }
    }

    #[cfg(windows)]
    fn label(self) -> String {
        match self {
            Self::BrowserProcessExited => "BrowserProcessExited".to_string(),
            Self::RenderProcessExited => "RenderProcessExited".to_string(),
            Self::RenderProcessUnresponsive => "RenderProcessUnresponsive".to_string(),
            Self::Other(raw) => format!("Other({raw})"),
        }
    }
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryAction {
    RebuildMainWindow,
    ReloadRenderer,
    Ignore,
    ExitApplication,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum BrowserRecoveryState {
    #[default]
    Ready,
    Rebuilding,
    Rebuilt,
    Failed,
}

#[cfg(any(windows, test))]
#[derive(Debug, Default)]
struct WebviewRecoveryState {
    browser: BrowserRecoveryState,
}

#[cfg(any(windows, test))]
impl WebviewRecoveryState {
    fn process_failed(&mut self, kind: ProcessFailureKind) -> RecoveryAction {
        match kind {
            ProcessFailureKind::BrowserProcessExited => match self.browser {
                BrowserRecoveryState::Ready => {
                    self.browser = BrowserRecoveryState::Rebuilding;
                    RecoveryAction::RebuildMainWindow
                }
                BrowserRecoveryState::Rebuilding => RecoveryAction::Ignore,
                BrowserRecoveryState::Rebuilt | BrowserRecoveryState::Failed => {
                    RecoveryAction::ExitApplication
                }
            },
            ProcessFailureKind::RenderProcessExited => RecoveryAction::ReloadRenderer,
            ProcessFailureKind::RenderProcessUnresponsive | ProcessFailureKind::Other(_) => {
                RecoveryAction::Ignore
            }
        }
    }

    fn finish_browser_rebuild(&mut self, succeeded: bool) -> RecoveryAction {
        match (self.browser, succeeded) {
            (BrowserRecoveryState::Rebuilding, true) => {
                self.browser = BrowserRecoveryState::Rebuilt;
                RecoveryAction::Ignore
            }
            (_, false) => {
                self.browser = BrowserRecoveryState::Failed;
                RecoveryAction::ExitApplication
            }
            (_, true) => RecoveryAction::ExitApplication,
        }
    }
}

#[cfg(windows)]
static RECOVERY_STATE: OnceLock<Mutex<WebviewRecoveryState>> = OnceLock::new();

#[cfg(windows)]
fn recovery_state() -> &'static Mutex<WebviewRecoveryState> {
    RECOVERY_STATE.get_or_init(|| Mutex::new(WebviewRecoveryState::default()))
}

#[cfg(windows)]
fn next_action(kind: ProcessFailureKind) -> RecoveryAction {
    recovery_state()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .process_failed(kind)
}

#[cfg(windows)]
fn finish_browser_rebuild(succeeded: bool) -> RecoveryAction {
    recovery_state()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .finish_browser_rebuild(succeeded)
}

#[cfg(windows)]
fn epoch_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(windows)]
fn log_crash_marker(kind: ProcessFailureKind, action: &str, detected_at_ms: u128, detail: &str) {
    log::error!(
        target: "cc_panes::webview_reliability",
        "[webview-crash-marker] kind={} action={} detected_at_ms={} decided_at_ms={} detail={}",
        kind.label(),
        action,
        detected_at_ms,
        epoch_millis(),
        detail
    );
}

#[cfg(windows)]
fn exit_after_webview_failure(
    app_handle: &tauri::AppHandle,
    kind: ProcessFailureKind,
    detected_at_ms: u128,
    detail: &str,
) {
    WEBVIEW_RECOVERY_HOLDS_EXIT.store(false, Ordering::Release);
    suspend_webview_emits();
    log_crash_marker(kind, "exit", detected_at_ms, detail);
    app_handle.exit(70);
}

#[cfg(windows)]
fn install_process_failed_handler(window: &tauri::WebviewWindow) -> anyhow::Result<()> {
    use tauri::Manager;
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
        ProcessFailedEventHandler,
    };

    let app_handle = window.app_handle().clone();
    window
        .with_webview(move |webview| {
            let registration = (|| -> anyhow::Result<i64> {
                let core_webview = unsafe { webview.controller().CoreWebView2() }
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                let callback_app = app_handle.clone();
                let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
                    let raw_kind = args
                        .and_then(|args| {
                            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(-1);
                            unsafe { args.ProcessFailedKind(&mut kind) }.ok()?;
                            Some(kind.0)
                        })
                        .unwrap_or(-1);
                    handle_process_failed(
                        callback_app.clone(),
                        ProcessFailureKind::from_raw(raw_kind),
                    );
                    Ok(())
                }));
                let mut token = 0;
                unsafe { core_webview.add_ProcessFailed(&handler, &mut token) }
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                Ok(token)
            })();

            match registration {
                Ok(token) => log::info!(
                    target: "cc_panes::webview_reliability",
                    "WebView2 ProcessFailed handler registered for main window (token={token})"
                ),
                Err(error) => {
                    let detected_at_ms = epoch_millis();
                    log_crash_marker(
                        ProcessFailureKind::Other(-1),
                        "handler-registration-failed",
                        detected_at_ms,
                        &error.to_string(),
                    );
                    app_handle.exit(70);
                }
            }
        })
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(())
}

#[cfg(windows)]
fn rebuild_main_window(app_handle: &tauri::AppHandle) -> anyhow::Result<()> {
    use tauri::Manager;

    let config = app_handle
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("main window config is missing"))?;
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| anyhow::anyhow!("failed main window is not registered"))?;
    window
        .destroy()
        .map_err(|error| anyhow::anyhow!("destroy failed main window: {error}"))?;

    for _ in 0..40 {
        if app_handle.get_webview_window("main").is_none() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    if app_handle.get_webview_window("main").is_some() {
        anyhow::bail!("failed main window did not unregister after destroy");
    }

    let rebuilt = tauri::WebviewWindowBuilder::from_config(app_handle, &config)
        .map_err(|error| anyhow::anyhow!("rebuild main window config failed: {error}"))?
        .build()
        .map_err(|error| anyhow::anyhow!("rebuild main window failed: {error}"))?;
    install_process_failed_handler(&rebuilt)?;
    Ok(())
}

#[cfg(windows)]
fn spawn_rebuild_watchdog(
    app_handle: tauri::AppHandle,
    kind: ProcessFailureKind,
    detected_at_ms: u128,
) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(10));
        if WEBVIEW_RECOVERY_HOLDS_EXIT
            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let action = finish_browser_rebuild(false);
            debug_assert_eq!(action, RecoveryAction::ExitApplication);
            exit_after_webview_failure(
                &app_handle,
                kind,
                detected_at_ms,
                "main window rebuild timed out after 10 seconds",
            );
        }
    });
}

#[cfg(windows)]
fn complete_browser_rebuild(
    app_handle: &tauri::AppHandle,
    kind: ProcessFailureKind,
    detected_at_ms: u128,
    result: anyhow::Result<()>,
) {
    match result {
        Ok(()) => {
            if WEBVIEW_RECOVERY_HOLDS_EXIT
                .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
                && finish_browser_rebuild(true) == RecoveryAction::Ignore
            {
                resume_webview_emits();
                log::info!(
                    target: "cc_panes::webview_reliability",
                    "main WebView rebuilt after {} (detected_at_ms={}, recovered_at_ms={})",
                    kind.label(),
                    detected_at_ms,
                    epoch_millis()
                );
            } else {
                exit_after_webview_failure(
                    app_handle,
                    kind,
                    detected_at_ms,
                    "main window rebuild completed after recovery timeout",
                );
            }
        }
        Err(error) => {
            let action = finish_browser_rebuild(false);
            debug_assert_eq!(action, RecoveryAction::ExitApplication);
            exit_after_webview_failure(
                app_handle,
                kind,
                detected_at_ms,
                &format!("main window rebuild failed: {error}"),
            );
        }
    }
}

#[cfg(windows)]
fn spawn_browser_rebuild(
    app_handle: tauri::AppHandle,
    kind: ProcessFailureKind,
    detected_at_ms: u128,
) {
    suspend_webview_emits();
    WEBVIEW_RECOVERY_HOLDS_EXIT.store(true, Ordering::Release);
    log_crash_marker(kind, "rebuild-main-window", detected_at_ms, "attempt=1");
    spawn_rebuild_watchdog(app_handle.clone(), kind, detected_at_ms);
    std::thread::spawn(move || {
        let result = rebuild_main_window(&app_handle);
        complete_browser_rebuild(&app_handle, kind, detected_at_ms, result);
    });
}

#[cfg(windows)]
fn escalate_renderer_reload_failure(
    app_handle: tauri::AppHandle,
    kind: ProcessFailureKind,
    detected_at_ms: u128,
    error: String,
) {
    match next_action(ProcessFailureKind::BrowserProcessExited) {
        RecoveryAction::RebuildMainWindow => {
            log::warn!(
                target: "cc_panes::webview_reliability",
                "renderer reload failed after {}: {}; escalating to main window rebuild",
                kind.label(),
                error
            );
            spawn_browser_rebuild(app_handle, kind, detected_at_ms);
        }
        RecoveryAction::Ignore => {}
        RecoveryAction::ExitApplication => exit_after_webview_failure(
            &app_handle,
            kind,
            detected_at_ms,
            &format!("renderer reload failed after rebuild budget was consumed: {error}"),
        ),
        RecoveryAction::ReloadRenderer => unreachable!("browser failure cannot request reload"),
    }
}

#[cfg(windows)]
fn spawn_renderer_reload(
    app_handle: tauri::AppHandle,
    kind: ProcessFailureKind,
    detected_at_ms: u128,
) {
    use tauri::Manager;

    std::thread::spawn(move || {
        let result = app_handle
            .get_webview_window("main")
            .ok_or_else(|| "main window is not registered".to_string())
            .and_then(|window| window.reload().map_err(|error| error.to_string()));
        if let Err(error) = result {
            escalate_renderer_reload_failure(app_handle, kind, detected_at_ms, error);
        }
    });
}

#[cfg(windows)]
fn handle_process_failed(app_handle: tauri::AppHandle, kind: ProcessFailureKind) {
    let detected_at_ms = epoch_millis();
    match next_action(kind) {
        RecoveryAction::RebuildMainWindow => {
            spawn_browser_rebuild(app_handle, kind, detected_at_ms)
        }
        RecoveryAction::ReloadRenderer => {
            log_crash_marker(kind, "reload-renderer", detected_at_ms, "attempt=1");
            spawn_renderer_reload(app_handle, kind, detected_at_ms);
        }
        RecoveryAction::Ignore => log::warn!(
            target: "cc_panes::webview_reliability",
            "WebView2 ProcessFailed observed without destructive recovery: kind={} detected_at_ms={}",
            kind.label(),
            detected_at_ms
        ),
        RecoveryAction::ExitApplication => exit_after_webview_failure(
            &app_handle,
            kind,
            detected_at_ms,
            "browser process failed after the single rebuild attempt",
        ),
    }
}

#[cfg(windows)]
pub(crate) fn install_main_webview_process_failed_handler(
    app_handle: &tauri::AppHandle,
) -> anyhow::Result<()> {
    use tauri::Manager;

    let main_window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| anyhow::anyhow!("main webview window is missing during setup"))?;
    install_process_failed_handler(&main_window)
}

#[cfg(not(windows))]
pub(crate) fn install_main_webview_process_failed_handler(
    _app_handle: &tauri::AppHandle,
) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_process_is_rebuilt_once_then_a_second_failure_exits() {
        let mut state = WebviewRecoveryState::default();

        assert_eq!(
            state.process_failed(ProcessFailureKind::BrowserProcessExited),
            RecoveryAction::RebuildMainWindow
        );
        assert_eq!(state.finish_browser_rebuild(true), RecoveryAction::Ignore);
        assert_eq!(
            state.process_failed(ProcessFailureKind::BrowserProcessExited),
            RecoveryAction::ExitApplication
        );
    }

    #[test]
    fn duplicate_browser_failure_during_rebuild_is_ignored() {
        let mut state = WebviewRecoveryState::default();

        assert_eq!(
            state.process_failed(ProcessFailureKind::BrowserProcessExited),
            RecoveryAction::RebuildMainWindow
        );
        assert_eq!(
            state.process_failed(ProcessFailureKind::BrowserProcessExited),
            RecoveryAction::Ignore
        );
    }

    #[test]
    fn failed_browser_rebuild_exits() {
        let mut state = WebviewRecoveryState::default();

        assert_eq!(
            state.process_failed(ProcessFailureKind::BrowserProcessExited),
            RecoveryAction::RebuildMainWindow
        );
        assert_eq!(
            state.finish_browser_rebuild(false),
            RecoveryAction::ExitApplication
        );
        assert_eq!(
            state.finish_browser_rebuild(true),
            RecoveryAction::ExitApplication,
            "迟到的重建成功不能覆盖已决定的自裁"
        );
    }

    #[test]
    fn renderer_failures_do_not_consume_the_browser_rebuild_attempt() {
        let mut state = WebviewRecoveryState::default();

        assert_eq!(
            state.process_failed(ProcessFailureKind::RenderProcessExited),
            RecoveryAction::ReloadRenderer
        );
        assert_eq!(
            state.process_failed(ProcessFailureKind::RenderProcessUnresponsive),
            RecoveryAction::Ignore
        );
        assert_eq!(
            state.process_failed(ProcessFailureKind::Other(9)),
            RecoveryAction::Ignore
        );
        assert_eq!(
            state.process_failed(ProcessFailureKind::BrowserProcessExited),
            RecoveryAction::RebuildMainWindow
        );
    }
}
