use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;

use cc_panes_core::models::settings::WebAccessSettings;
use cc_panes_core::utils::{no_window_command, AppPaths, AppResult};
use serde::Serialize;
use tracing::{info, warn};

use crate::utils::AppError;

const WEB_BIN_ENV: &str = "CCPANES_WEB_BIN";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebAccessStatus {
    pub enabled: bool,
    pub running: bool,
    pub pid: Option<u32>,
    pub url: String,
    pub bind_host: String,
    pub port: u16,
    pub lan_requested: bool,
    pub lan_active: bool,
    pub auth_required: bool,
    pub password_configured: bool,
}

struct WebAccessProcess {
    child: Child,
    port: u16,
    bind_host: String,
}

#[derive(Default)]
pub struct WebAccessLifecycle {
    process: Mutex<Option<WebAccessProcess>>,
}

impl WebAccessLifecycle {
    pub fn status(&self, settings: &WebAccessSettings) -> WebAccessStatus {
        let mut guard = self.process.lock().unwrap_or_else(|err| err.into_inner());
        let running = guard
            .as_mut()
            .is_some_and(|process| match process.child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) | Err(_) => false,
            });
        if !running {
            *guard = None;
        }
        let pid = guard.as_ref().map(|process| process.child.id());
        let bind_host = guard
            .as_ref()
            .map(|process| process.bind_host.clone())
            .unwrap_or_else(|| desired_bind_host(settings));
        let port = guard
            .as_ref()
            .map(|process| process.port)
            .unwrap_or(settings.port);

        WebAccessStatus {
            enabled: settings.enabled,
            running,
            pid,
            url: local_url(port),
            bind_host,
            port,
            lan_requested: settings.allow_lan,
            lan_active: settings.allow_lan && settings.auth_required(),
            auth_required: settings.auth_required(),
            password_configured: settings.password_configured(),
        }
    }

    /// [daemon_expected]：终端设置里是否开启了会话共享（daemon）。
    /// 开了但 manifest 不存在时告警——此时 Web 端会退回独立会话池，
    /// 手机/浏览器看到的会话与桌面不是同一批。
    pub fn start(
        &self,
        app_paths: &AppPaths,
        resource_dir: Option<&Path>,
        settings: &WebAccessSettings,
        daemon_expected: bool,
    ) -> AppResult<WebAccessStatus> {
        if !settings.enabled {
            self.stop();
            return Ok(self.status(settings));
        }

        let bind_host = desired_bind_host(settings);
        if let Some(status) = self.reuse_running(settings, &bind_host) {
            return Ok(status);
        }

        self.stop();
        let binary = resolve_web_binary(resource_dir)?;
        let mut command = no_window_command(&binary);
        command
            .arg("--port")
            .arg(settings.port.to_string())
            .arg("--host")
            .arg(&bind_host)
            .arg("--cwd")
            .arg(app_paths.data_dir())
            .arg("--data-dir")
            .arg(app_paths.data_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        if let Some(dist_dir) = resolve_web_dist_dir(resource_dir) {
            command.env("CCPANES_WEB_DIST_DIR", dist_dir);
        }

        let daemon_manifest = app_paths.runtime_dir().join("daemon-manifest.json");
        if daemon_manifest.exists() {
            command.arg("--daemon-manifest").arg(daemon_manifest);
        } else if daemon_expected {
            warn!(
                manifest = %daemon_manifest.display(),
                "terminal daemon enabled in settings but manifest missing; \
                 Web server will use an isolated session pool (sessions won't match desktop)"
            );
        }

        let child = command.spawn().map_err(|error| {
            AppError::from(format!(
                "failed to start Web access server {}: {}",
                binary.display(),
                error
            ))
        })?;
        info!(
            binary = %binary.display(),
            port = settings.port,
            bind_host,
            "Web access server start requested"
        );

        *self.process.lock().unwrap_or_else(|err| err.into_inner()) = Some(WebAccessProcess {
            child,
            port: settings.port,
            bind_host,
        });
        Ok(self.status(settings))
    }

    pub fn restart(
        &self,
        app_paths: &AppPaths,
        resource_dir: Option<&Path>,
        settings: &WebAccessSettings,
        daemon_expected: bool,
    ) -> AppResult<WebAccessStatus> {
        self.stop();
        self.start(app_paths, resource_dir, settings, daemon_expected)
    }

    pub fn stop(&self) {
        let mut guard = self.process.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(mut process) = guard.take() {
            if let Err(error) = process.child.kill() {
                warn!(error = %error, "failed to stop Web access server");
            }
            let _ = process.child.wait();
        }
    }

    fn reuse_running(
        &self,
        settings: &WebAccessSettings,
        bind_host: &str,
    ) -> Option<WebAccessStatus> {
        let mut guard = self.process.lock().unwrap_or_else(|err| err.into_inner());
        let process = guard.as_mut()?;
        let still_running = matches!(process.child.try_wait(), Ok(None));
        if !still_running {
            *guard = None;
            return None;
        }
        if process.port == settings.port && process.bind_host == bind_host {
            drop(guard);
            return Some(self.status(settings));
        }
        None
    }
}

pub fn local_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

fn desired_bind_host(settings: &WebAccessSettings) -> String {
    if settings.allow_lan && settings.auth_required() {
        "0.0.0.0".to_string()
    } else {
        "127.0.0.1".to_string()
    }
}

fn resolve_web_binary(resource_dir: Option<&Path>) -> AppResult<PathBuf> {
    let binary_name = web_binary_name();

    if let Ok(explicit) = std::env::var(WEB_BIN_ENV) {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Ok(path);
        }
    }

    if let Some(resource_dir) = resource_dir {
        let candidate = resource_dir.join("binaries").join(binary_name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidate = exe_dir.join("binaries").join(binary_name);
            if candidate.exists() {
                return Ok(candidate);
            }

            let candidate = exe_dir.join(binary_name);
            if candidate.exists() {
                return Ok(candidate);
            }

            #[cfg(target_os = "macos")]
            if let Some(contents_dir) = exe_dir.parent() {
                let candidate = contents_dir
                    .join("Resources")
                    .join("binaries")
                    .join(binary_name);
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
    }

    for candidate in workspace_web_candidates(binary_name) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(AppError::from(format!(
        "cc-panes-web binary not found; set {WEB_BIN_ENV} or run `cargo build -p cc-panes-web`"
    )))
}

fn resolve_web_dist_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("CCPANES_WEB_DIST_DIR") {
        let path = PathBuf::from(explicit);
        if path.join("index.html").exists() {
            return Some(path);
        }
    }

    if let Some(resource_dir) = resource_dir {
        let candidate = resource_dir.join("resources").join("web-dist");
        if candidate.join("index.html").exists() {
            return Some(candidate);
        }
    }

    workspace_web_dist_candidates()
        .into_iter()
        .find(|candidate| candidate.join("index.html").exists())
}

fn workspace_web_dist_candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        roots.push(current_dir);
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            roots.push(exe_dir.to_path_buf());
        }
    }

    let mut candidates = Vec::new();
    for root in roots {
        let mut dir = root.as_path();
        for _ in 0..6 {
            candidates.push(dir.join("dist"));
            candidates.push(dir.join("resources").join("web-dist"));
            candidates.push(dir.join("src-tauri").join("resources").join("web-dist"));
            if let Some(parent) = dir.parent() {
                dir = parent;
            } else {
                break;
            }
        }
    }
    candidates
}

fn workspace_web_candidates(binary_name: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        roots.push(current_dir);
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            roots.push(exe_dir.to_path_buf());
        }
    }

    let mut candidates = Vec::new();
    for root in roots {
        let mut dir = root.as_path();
        for _ in 0..6 {
            candidates.push(dir.join("target").join("debug").join(binary_name));
            candidates.push(dir.join("target").join("release").join(binary_name));
            if let Some(parent) = dir.parent() {
                dir = parent;
            } else {
                break;
            }
        }
    }
    candidates
}

fn web_binary_name() -> &'static str {
    if cfg!(windows) {
        "cc-panes-web.exe"
    } else {
        "cc-panes-web"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_binding_requires_auth_to_be_configured() {
        let mut settings = WebAccessSettings {
            allow_lan: true,
            auth_enabled: true,
            ..WebAccessSettings::default()
        };
        assert_eq!(desired_bind_host(&settings), "127.0.0.1");

        settings.password_salt = Some("00".into());
        settings.password_hash = Some("hash".into());
        assert_eq!(desired_bind_host(&settings), "0.0.0.0");
    }

    #[test]
    fn local_url_uses_loopback() {
        assert_eq!(local_url(18080), "http://127.0.0.1:18080/");
    }
}
