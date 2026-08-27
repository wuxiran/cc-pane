//! Desktop lifecycle for the bundled/local ComfyUI Python engine.

use super::process_guard::{configure_command, ProcessGuard};
use cc_panes_core::services::ComfyAdapterProfile;
use cc_panes_core::utils::{no_window_command, AppPaths, AppResult};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};

use crate::utils::AppError;

pub const COMFY_LOCAL_PROVIDER_ID: &str = "comfy-local";
const COMFY_DIR_ENV: &str = "CCPANES_COMFYUI_DIR";
const COMFY_PYTHON_ENV: &str = "CCPANES_COMFY_PYTHON";
const STOP_GRACE: Duration = Duration::from_secs(3);
const STDERR_LIMIT: usize = 16 * 1024;
const READINESS_PROBE_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyRuntimeStatus {
    pub enabled: bool,
    pub running: bool,
    pub pid: Option<u32>,
    pub port: u16,
    pub base_url: String,
    pub root: Option<String>,
    pub python: Option<String>,
    pub startup_error: Option<String>,
    pub ready: bool,
    pub readiness: String,
    pub readiness_error: Option<String>,
    pub stderr: Option<String>,
}

struct ComfyProcess {
    child: Child,
    guard: ProcessGuard,
    port: u16,
    root: PathBuf,
    python: PathBuf,
    stderr: Arc<Mutex<String>>,
}

pub struct ComfyRuntimeService {
    process: Mutex<Option<ComfyProcess>>,
    port: Mutex<u16>,
    startup_error: Mutex<Option<String>>,
    ready: Arc<Mutex<bool>>,
    readiness_error: Arc<Mutex<Option<String>>>,
    last_stderr: Arc<Mutex<Option<String>>>,
}

impl Default for ComfyRuntimeService {
    fn default() -> Self {
        Self::new()
    }
}

impl ComfyRuntimeService {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            port: Mutex::new(0),
            startup_error: Mutex::new(None),
            ready: Arc::new(Mutex::new(false)),
            readiness_error: Arc::new(Mutex::new(None)),
            last_stderr: Arc::new(Mutex::new(None)),
        }
    }

    pub fn status(&self) -> ComfyRuntimeStatus {
        let mut process = self
            .process
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let running = process
            .as_mut()
            .is_some_and(|entry| matches!(entry.child.try_wait(), Ok(None)));
        if !running {
            if let Some(entry) = process.as_ref() {
                let stderr = entry
                    .stderr
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                if !stderr.is_empty() {
                    *self
                        .last_stderr
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(stderr);
                }
            }
            *process = None;
            *self
                .ready
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
            *self
                .port
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = 0;
        }
        let port = process
            .as_ref()
            .map(|entry| entry.port)
            .unwrap_or_else(|| *self.port.lock().unwrap_or_else(|error| error.into_inner()));
        if running
            && !*self
                .ready
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        {
            match probe_ready(port) {
                Ok(true) => {
                    *self
                        .ready
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
                    *self
                        .readiness_error
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                }
                Ok(false) => {}
                Err(error) => {
                    *self
                        .readiness_error
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
                }
            }
        }
        let stderr = process
            .as_ref()
            .and_then(|entry| {
                let value = entry
                    .stderr
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                summarize_stderr(&value)
            })
            .or_else(|| {
                self.last_stderr
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .as_deref()
                    .and_then(summarize_stderr)
            });
        let ready = *self
            .ready
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ComfyRuntimeStatus {
            enabled: true,
            running,
            pid: process.as_ref().map(|entry| entry.child.id()),
            port,
            base_url: format!("http://127.0.0.1:{port}/"),
            root: process
                .as_ref()
                .map(|entry| entry.root.to_string_lossy().into_owned()),
            python: process
                .as_ref()
                .map(|entry| entry.python.to_string_lossy().into_owned()),
            startup_error: self
                .startup_error
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone(),
            ready,
            readiness: if !running {
                "stopped".to_string()
            } else if ready {
                "ready".to_string()
            } else {
                "starting".to_string()
            },
            readiness_error: self
                .readiness_error
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            stderr,
        }
    }

    /// Return a profile for the local adapter. The port is chosen at start and
    /// remains stable for the lifetime of this service.
    pub fn adapter_profile(&self) -> AppResult<ComfyAdapterProfile> {
        let port = *self.port.lock().unwrap_or_else(|error| error.into_inner());
        if port == 0 {
            return Err(AppError::coded(
                "COMFY_RUNTIME_NOT_STARTED",
                "ComfyUI runtime has not selected a port",
            ));
        }
        ComfyAdapterProfile::new(COMFY_LOCAL_PROVIDER_ID, format!("http://127.0.0.1:{port}/"))
    }

    pub fn start(
        &self,
        app_paths: &AppPaths,
        resource_dir: Option<&Path>,
    ) -> AppResult<ComfyRuntimeStatus> {
        let already_running = {
            let mut process = self
                .process
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(entry) = process.as_mut() {
                if matches!(entry.child.try_wait(), Ok(None)) {
                    true
                } else {
                    let stderr = entry
                        .stderr
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone();
                    if !stderr.is_empty() {
                        *self
                            .last_stderr
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(stderr);
                    }
                    *process = None;
                    *self
                        .ready
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
                    false
                }
            } else {
                false
            }
        };
        if already_running {
            return Ok(self.status());
        }
        let root = resolve_comfy_root(resource_dir).ok_or_else(|| {
            AppError::coded(
                "COMFY_RUNTIME_NOT_FOUND",
                "ComfyUI directory not found; set CCPANES_COMFYUI_DIR or bundle resources/comfyui",
            )
        })?;
        let python = resolve_python(&root).ok_or_else(|| {
            AppError::coded(
                "COMFY_PYTHON_NOT_FOUND",
                "Python runtime for ComfyUI was not found",
            )
        })?;
        let port = choose_port()?;
        let output_dir = app_paths.runtime_dir().join("comfy-output");
        let temp_dir = app_paths.runtime_dir().join("comfy-temp");
        std::fs::create_dir_all(&output_dir)?;
        std::fs::create_dir_all(&temp_dir)?;

        let mut command = no_window_command(&python);
        command
            .current_dir(&root)
            .arg("main.py")
            .arg("--listen")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("--disable-auto-launch")
            .arg("--disable-api-nodes")
            .arg("--dont-print-server")
            .arg("--output-directory")
            .arg(&output_dir)
            .arg("--temp-directory")
            .arg(&temp_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_command(&mut command);
        let mut child = command.spawn().map_err(|error| {
            AppError::from(format!(
                "failed to start ComfyUI Python process {}: {error}",
                python.display()
            ))
        })?;
        let stderr_buffer = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            spawn_log_reader(stderr, stderr_buffer.clone());
        }
        if let Some(stdout) = child.stdout.take() {
            spawn_drain_reader(stdout);
        }
        let guard = match ProcessGuard::attach(&child) {
            Ok(guard) => guard,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::from(format!(
                    "failed to guard ComfyUI process tree: {error}"
                )));
            }
        };
        *self.port.lock().unwrap_or_else(|error| error.into_inner()) = port;
        *self
            .startup_error
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        *self
            .ready
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
        *self
            .readiness_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .last_stderr
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .process
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(ComfyProcess {
            child,
            guard,
            port,
            root: root.clone(),
            python: python.clone(),
            stderr: stderr_buffer,
        });
        info!(
            root = %root.display(),
            python = %python.display(),
            port,
            "ComfyUI runtime start requested"
        );
        Ok(self.status())
    }

    pub fn start_recording_error(
        &self,
        app_paths: &AppPaths,
        resource_dir: Option<&Path>,
    ) -> ComfyRuntimeStatus {
        match self.start(app_paths, resource_dir) {
            Ok(status) => status,
            Err(error) => {
                warn!(error = %error, "ComfyUI runtime unavailable");
                *self
                    .startup_error
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error.to_string());
                self.status()
            }
        }
    }

    pub fn stop(&self) {
        let process = {
            let mut guard = self
                .process
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            guard.take()
        };
        let Some(mut process) = process else {
            *self
                .ready
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
            *self
                .port
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = 0;
            return;
        };
        *self
            .ready
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
        *self
            .port
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = 0;
        let stderr = process
            .stderr
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if !stderr.is_empty() {
            *self
                .last_stderr
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(stderr);
        }
        process.guard.request_terminate(&mut process.child);
        let deadline = Instant::now() + STOP_GRACE;
        loop {
            match process.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Ok(None) => break,
                Err(error) => {
                    warn!(error = %error, "failed to poll ComfyUI process exit");
                    break;
                }
            }
        }
        process.guard.force_kill(&mut process.child);
        let _ = process.child.wait();
    }

    pub fn restart(&self, app_paths: &AppPaths, resource_dir: Option<&Path>) -> ComfyRuntimeStatus {
        self.stop();
        self.start_recording_error(app_paths, resource_dir)
    }
}

impl Drop for ComfyRuntimeService {
    fn drop(&mut self) {
        self.stop();
    }
}

fn choose_port() -> AppResult<u16> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| {
            AppError::from(format!("failed to allocate a local ComfyUI port: {error}"))
        })
}

fn spawn_log_reader<R>(mut reader: R, buffer: Arc<Mutex<String>>)
where
    R: Read + Send + 'static,
{
    let _ = std::thread::Builder::new()
        .name("cc-panes-comfy-stderr".to_string())
        .spawn(move || {
            let mut chunk = [0_u8; 2048];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        let text = String::from_utf8_lossy(&chunk[..size]);
                        let mut value = buffer
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        value.push_str(&text);
                        if value.len() > STDERR_LIMIT {
                            let start = value
                                .char_indices()
                                .nth(value.chars().count().saturating_sub(STDERR_LIMIT))
                                .map(|(index, _)| index)
                                .unwrap_or(0);
                            value.drain(..start);
                        }
                    }
                }
            }
        });
}

fn spawn_drain_reader<R>(mut reader: R)
where
    R: Read + Send + 'static,
{
    let _ = std::thread::Builder::new()
        .name("cc-panes-comfy-stdout".to_string())
        .spawn(move || {
            let mut chunk = [0_u8; 4096];
            while reader.read(&mut chunk).ok().is_some_and(|size| size > 0) {}
        });
}

fn summarize_stderr(value: &str) -> Option<String> {
    let lines = value
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(8)
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if ["api_key", "apikey", "authorization", "bearer ", "token="]
                .iter()
                .any(|marker| lower.contains(marker))
            {
                "[redacted ComfyUI diagnostic]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    let mut summary = lines.into_iter().rev().collect::<Vec<_>>().join("\n");
    if summary.len() > 1024 {
        summary.truncate(1024);
        summary.push_str("...");
    }
    Some(summary)
}

fn probe_ready(port: u16) -> Result<bool, String> {
    if port == 0 {
        return Ok(false);
    }
    let address = format!("127.0.0.1:{port}");
    let mut stream = match TcpStream::connect_timeout(
        &address
            .parse()
            .map_err(|error| format!("invalid ComfyUI probe address: {error}"))?,
        READINESS_PROBE_TIMEOUT,
    ) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::TimedOut
                    | std::io::ErrorKind::WouldBlock
            ) =>
        {
            return Ok(false)
        }
        Err(error) => return Err(format!("ComfyUI readiness probe failed: {error}")),
    };
    stream
        .set_read_timeout(Some(READINESS_PROBE_TIMEOUT))
        .map_err(|error| format!("ComfyUI readiness probe setup failed: {error}"))?;
    stream
        .set_write_timeout(Some(READINESS_PROBE_TIMEOUT))
        .map_err(|error| format!("ComfyUI readiness probe setup failed: {error}"))?;
    stream
        .write_all(b"GET /system_stats HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|error| format!("ComfyUI readiness probe write failed: {error}"))?;
    let mut bytes = [0_u8; 256];
    let size = stream
        .read(&mut bytes)
        .map_err(|error| format!("ComfyUI readiness probe read failed: {error}"))?;
    let first_line = std::str::from_utf8(&bytes[..size])
        .ok()
        .and_then(|text| text.lines().next())
        .unwrap_or_default();
    let status = first_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok());
    Ok(status.is_some_and(|value| (200..300).contains(&value)))
}

fn resolve_comfy_root(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(path) = std::env::var(COMFY_DIR_ENV) {
        let path = PathBuf::from(path);
        if is_comfy_root(&path) {
            return Some(path);
        }
    }
    if let Some(resource_dir) = resource_dir {
        for candidate in [
            resource_dir.join("comfyui"),
            resource_dir.join("resources").join("comfyui"),
        ] {
            if is_comfy_root(&candidate) {
                return Some(candidate);
            }
        }
    }
    let mut roots = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        roots.push(current);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    roots
        .into_iter()
        .flat_map(|root| {
            let mut candidates = Vec::new();
            let mut current = root.as_path();
            for _ in 0..5 {
                candidates.push(current.join("ComfyUI-master"));
                candidates.push(current.join("comfyui"));
                if let Some(parent) = current.parent() {
                    current = parent;
                } else {
                    break;
                }
            }
            candidates
        })
        .find(|candidate| is_comfy_root(candidate))
}

fn is_comfy_root(path: &Path) -> bool {
    path.is_dir() && path.join("main.py").is_file() && path.join("comfy").is_dir()
}

fn resolve_python(root: &Path) -> Option<PathBuf> {
    if let Ok(path) = std::env::var(COMFY_PYTHON_ENV) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let names = if cfg!(windows) {
        vec![
            root.join("python_embeded").join("python.exe"),
            root.join(".venv").join("Scripts").join("python.exe"),
            root.join("venv").join("Scripts").join("python.exe"),
        ]
    } else {
        vec![
            root.join(".venv").join("bin").join("python"),
            root.join("venv").join("bin").join("python"),
        ]
    };
    names
        .into_iter()
        .find(|candidate| candidate.is_file())
        .or_else(|| {
            ["python", "python3"]
                .iter()
                .find_map(|name| which::which(name).ok())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_comfy_root() {
        assert!(!is_comfy_root(Path::new("C:\\does-not-exist")));
    }

    #[test]
    fn local_profile_is_loopback() {
        let service = ComfyRuntimeService::new();
        *service.port.lock().unwrap() = 8188;
        let profile = service.adapter_profile().unwrap();
        assert_eq!(profile.base_url, "http://127.0.0.1:8188/");
    }

    #[test]
    fn stderr_summary_is_bounded_and_redacts_secret_markers() {
        let summary = summarize_stderr("boot\napi_key=super-secret\nready\n").unwrap();
        assert!(summary.contains("[redacted ComfyUI diagnostic]"));
        assert!(!summary.contains("super-secret"));
    }
}
