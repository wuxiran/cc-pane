//! macOS supplies the selection UI and physical-pixel PNG, including mixed-DPI
//! displays. Do not pre-capture a monitor or scale the selected coordinates.
use super::ScreenshotService;
use crate::models::ScreenshotResult;
use crate::utils::AppResult;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tracing::{debug, error, info, warn};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[derive(Clone, Copy)]
struct WindowSnapshot {
    visible: bool,
    minimized: bool,
    focused: bool,
}

impl WindowSnapshot {
    fn needs_hiding(self) -> bool {
        self.visible && !self.minimized
    }
}

struct CaptureSession {
    restore: Option<(tauri::WebviewWindow, WindowSnapshot)>,
    capturing: &'static AtomicBool,
}

impl CaptureSession {
    fn hide_visible_window(&mut self, app: &tauri::AppHandle) -> AppResult<()> {
        let Some(window) = app.get_webview_window("main") else {
            return Ok(());
        };
        let snapshot = WindowSnapshot {
            visible: window.is_visible().map_err(|e| e.to_string())?,
            minimized: window.is_minimized().map_err(|e| e.to_string())?,
            focused: window.is_focused().map_err(|e| e.to_string())?,
        };
        if snapshot.needs_hiding() {
            self.restore = Some((window.clone(), snapshot));
            window.hide().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        // Hidden and minimized windows are never changed, even after cancel or
        // an error. The closure also owns this guard when thread creation fails.
        if let Some((window, snapshot)) = self.restore.take() {
            if let Err(error) = window.show() {
                warn!(%error, "failed to restore screenshot window");
            }
            if snapshot.focused {
                if let Err(error) = window.set_focus() {
                    warn!(%error, "failed to restore screenshot focus");
                }
            }
        }
        self.capturing.store(false, Ordering::SeqCst);
    }
}

pub(super) fn trigger(
    app: tauri::AppHandle,
    retention_days: u32,
    capturing: &'static AtomicBool,
    mut events: super::super::screenshot_events::ScreenshotEvents,
) {
    let mut session = CaptureSession {
        restore: None,
        capturing,
    };
    if let Err(error) = session.hide_visible_window(&app) {
        events.failed(&error);
        drop(session);
        report_error(&app, error);
        return;
    }
    let worker_app = app.clone();
    if let Err(error) = cc_panes_core::pty::thread::spawn_named("cc-panes-screenshot", move || {
        // Let the compositor remove the app before native selection begins.
        if session.restore.is_some() {
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        let result = capture_region(&ScreenshotService::screenshots_dir(), retention_days)
            .and_then(|result| {
                if let Some(result) = result {
                    events.saved(&result);
                    worker_app
                        .clipboard()
                        .write_text(&result.file_path)
                        .map_err(|e| {
                            format!(
                                "Screenshot saved at {}, but copying its path failed: {e}",
                                result.file_path
                            )
                        })?;
                    info!(path = result.file_path, "screenshot saved and copied");
                } else {
                    debug!("screenshot cancelled or sent to the native clipboard");
                }
                Ok(())
            });
        if let Err(error) = &result {
            events.failed(error);
        }
        drop(session);
        if let Err(error) = result {
            report_error(&worker_app, error);
        }
    }) {
        report_error(&app, format!("Could not start screenshot capture: {error}"));
    }
}

fn report_error(app: &tauri::AppHandle, error: impl std::fmt::Display) {
    error!(%error, "screenshot failed");
    app.dialog()
        .message(error.to_string())
        .title("Screenshot failed")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

fn capture_region(save_dir: &Path, retention_days: u32) -> AppResult<Option<ScreenshotResult>> {
    // Only this user-triggered path may show the system permission request.
    // Resolve permission before selection so Escape is never treated as denial.
    let permitted = screen_capture_permitted(
        || unsafe { CGPreflightScreenCaptureAccess() },
        || unsafe { CGRequestScreenCaptureAccess() },
    );
    capture_region_with(save_dir, retention_days, permitted, |path| {
        Command::new("/usr/sbin/screencapture")
            .args(["-i", "-s", "-x", "-t", "png"])
            .arg(path)
            .output()
            .map_err(|e| format!("Could not launch macOS screenshot selection: {e}").into())
    })
}

fn screen_capture_permitted(
    preflight: impl FnOnce() -> bool,
    request: impl FnOnce() -> bool,
) -> bool {
    preflight() || request()
}

fn capture_region_with(
    save_dir: &Path,
    retention_days: u32,
    permitted: bool,
    run: impl FnOnce(&Path) -> AppResult<Output>,
) -> AppResult<Option<ScreenshotResult>> {
    if !permitted {
        return Err("Allow CC-Panes to record the screen in System Settings > Privacy & Security > Screen Recording, then retry the screenshot.".into());
    }
    std::fs::create_dir_all(save_dir)
        .map_err(|e| format!("Failed to create screenshots directory: {e}"))?;
    // A private temporary directory avoids filename races and cleans cancelled
    // or failed captures. Staying on the destination volume permits rename.
    let temp = tempfile::Builder::new()
        .prefix(".capture-")
        .tempdir_in(save_dir)
        .map_err(|e| format!("Failed to prepare screenshot file: {e}"))?;
    let captured = temp.path().join("selection.png");
    let output = run(&captured)?;
    if !capture_completed(&output, captured.exists())? {
        return Ok(None);
    }
    let (width, height) =
        image::image_dimensions(&captured).map_err(|e| format!("Invalid screenshot image: {e}"))?;
    let destination = ScreenshotService::new_screenshot_path(save_dir);
    std::fs::rename(&captured, &destination)
        .map_err(|e| format!("Failed to save screenshot: {e}"))?;
    ScreenshotService::schedule_cleanup(save_dir, retention_days);
    Ok(Some(ScreenshotService::build_result(
        &destination,
        width,
        height,
    )))
}

fn capture_completed(output: &Output, has_file: bool) -> AppResult<bool> {
    let details = String::from_utf8_lossy(&output.stderr);
    let details = details.trim();
    // Escape produces no image; native Control-selection may instead put the
    // image on the clipboard. In either case preserve the existing clipboard.
    if !has_file && details.is_empty() && matches!(output.status.code(), Some(0 | 1)) {
        return Ok(false);
    }
    if !output.status.success() || !has_file {
        return Err(format!(
            "macOS screenshot capture failed ({}): {}",
            output.status,
            if details.is_empty() {
                "no image was produced"
            } else {
                details
            }
        )
        .into());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    fn output(code: i32, stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(code << 8),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn granted_permission_does_not_request_access_again() {
        assert!(screen_capture_permitted(
            || true,
            || panic!("must not request")
        ));
    }

    #[test]
    fn missing_permission_requests_access_once_and_respects_the_result() {
        for granted in [true, false] {
            let requests = std::cell::Cell::new(0);
            let permitted = screen_capture_permitted(
                || false,
                || {
                    requests.set(requests.get() + 1);
                    granted
                },
            );
            assert_eq!(permitted, granted);
            assert_eq!(requests.get(), 1);
        }
    }

    #[test]
    fn permission_denial_never_launches_capture_or_creates_files() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("screenshots");
        let result = capture_region_with(&directory, 0, false, |_| panic!("must not launch"));
        assert!(result.unwrap_err().to_string().contains("Screen Recording"));
        assert!(!directory.exists());
    }

    #[test]
    fn escape_is_cancelled_without_an_error_and_removes_temporary_files() {
        let temp = tempfile::tempdir().unwrap();
        for status in [0, 1] {
            let result = capture_region_with(temp.path(), 0, true, |_| Ok(output(status, "")));
            assert!(result.unwrap().is_none());
            assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn native_failure_is_not_mistaken_for_cancel() {
        let temp = tempfile::tempdir().unwrap();
        let result = capture_region_with(temp.path(), 0, true, |_| {
            Ok(output(1, "could not create image from display"))
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("could not create image"));
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn captured_png_keeps_native_pixels_and_encoding() {
        let temp = tempfile::tempdir().unwrap();
        let mut original = Vec::new();
        let result = capture_region_with(temp.path(), 0, true, |path| {
            image::RgbaImage::new(8, 4).save(path).unwrap();
            original = std::fs::read(path).unwrap();
            Ok(output(0, ""))
        })
        .unwrap()
        .unwrap();
        assert_eq!((result.width, result.height), (8, 4));
        assert_eq!(std::fs::read(&result.file_path).unwrap(), original);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_capture_is_cleaned_without_publishing_a_screenshot() {
        let temp = tempfile::tempdir().unwrap();
        let result = capture_region_with(temp.path(), 0, true, |path| {
            std::fs::write(path, b"invalid png").unwrap();
            Ok(output(0, ""))
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn hidden_and_minimized_windows_are_never_hidden_or_restored() {
        for (visible, minimized, expected) in [
            (false, false, false),
            (false, true, false),
            (true, true, false),
            (true, false, true),
        ] {
            assert_eq!(
                WindowSnapshot {
                    visible,
                    minimized,
                    focused: false
                }
                .needs_hiding(),
                expected
            );
        }
    }

    #[test]
    fn session_drop_releases_capture_lock_during_unwind() {
        static CAPTURING: AtomicBool = AtomicBool::new(true);
        let result = std::panic::catch_unwind(|| {
            let _session = CaptureSession {
                restore: None,
                capturing: &CAPTURING,
            };
            panic!("injected worker panic");
        });
        assert!(result.is_err());
        assert!(!CAPTURING.load(Ordering::SeqCst));
    }
}
