use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Process-wide `which` cache so PATH scans do not repeatedly block terminal startup.
pub(super) fn cached_which(name: &str) -> Result<PathBuf, which::Error> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<PathBuf>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cache.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(cached) = map.get(name) {
        return cached.clone().ok_or(which::Error::CannotFindBinaryPath);
    }
    let result = which::which(name);
    map.insert(name.to_string(), result.as_ref().ok().cloned());
    result
}

/// Shell metadata returned to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    pub path: String,
}

impl ShellInfo {
    fn new(id: &str, name: &str, path: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            path: path.to_string(),
        }
    }
}

/// Resolve the platform default shell.
pub(super) fn resolve_default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        if cached_which("pwsh").is_ok() {
            return ("pwsh".to_string(), vec![]);
        }
        if cached_which("powershell").is_ok() {
            return ("powershell".to_string(), vec![]);
        }
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        (comspec, vec![])
    }

    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        (shell, vec![])
    }
}

/// Detect available local shells.
pub(super) fn detect_shells() -> Vec<ShellInfo> {
    let mut shells = vec![];

    #[cfg(windows)]
    {
        if let Ok(path) = cached_which("pwsh") {
            shells.push(ShellInfo::new(
                "pwsh",
                "PowerShell 7",
                &path.to_string_lossy(),
            ));
        }
        if let Ok(path) = cached_which("powershell") {
            shells.push(ShellInfo::new(
                "powershell",
                "Windows PowerShell",
                &path.to_string_lossy(),
            ));
        }

        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        shells.push(ShellInfo::new("cmd", "Command Prompt", &comspec));

        let git_bash = "C:\\Program Files\\Git\\bin\\bash.exe";
        if std::path::Path::new(git_bash).exists() {
            shells.push(ShellInfo::new("git-bash", "Git Bash", git_bash));
        }

        if cached_which("wsl").is_ok() {
            shells.push(ShellInfo::new("wsl", "WSL", "wsl"));
        }
    }

    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let name = std::path::Path::new(&shell)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "sh".to_string());
        shells.push(ShellInfo::new(&name, &name, &shell));

        for (id, name, path) in &[
            ("bash", "Bash", "/bin/bash"),
            ("zsh", "Zsh", "/bin/zsh"),
            ("fish", "Fish", "/usr/bin/fish"),
        ] {
            if std::path::Path::new(path).exists() && !shells.iter().any(|shell| shell.id == *id)
            {
                shells.push(ShellInfo::new(id, name, path));
            }
        }
    }

    shells
}

/// Resolve a shell path from configured shell id.
pub(super) fn resolve_shell(shell_id: Option<&str>) -> (String, Vec<String>) {
    if let Some(id) = shell_id {
        let shells = detect_shells();
        if let Some(shell) = shells.iter().find(|shell| shell.id == id) {
            return (shell.path.clone(), vec![]);
        }
    }

    resolve_default_shell()
}
