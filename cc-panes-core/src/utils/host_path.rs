use std::collections::HashMap;
use std::path::Path;

use crate::utils::error::AppError;
use crate::utils::error_codes as EC;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPlatform {
    Windows,
    Unix,
}

impl HostPlatform {
    pub fn current() -> Self {
        #[cfg(windows)]
        {
            Self::Windows
        }
        #[cfg(not(windows))]
        {
            Self::Unix
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchRuntime {
    Local,
    Wsl,
    Ssh,
}

fn path_params(path: &str) -> HashMap<String, String> {
    HashMap::from([("path".into(), path.into())])
}

fn is_windows_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\'))
        || path.starts_with(r"\\")
}

fn contains_parent_component(path: &str) -> bool {
    path.split(['/', '\\']).any(|component| component == "..")
}

pub fn classify_launch_cwd_for_host(
    path: &str,
    runtime: LaunchRuntime,
    host: HostPlatform,
) -> Result<(), AppError> {
    if runtime == LaunchRuntime::Ssh {
        return Ok(());
    }
    if runtime == LaunchRuntime::Wsl && host != HostPlatform::Windows {
        return Err(AppError::coded(
            EC::WSL_UNSUPPORTED,
            "WSL launch is only supported on Windows",
        ));
    }
    if path.is_empty() {
        return Err(AppError::coded(EC::PATH_EMPTY, "Path cannot be empty"));
    }
    if contains_parent_component(path) {
        return Err(AppError::coded_with_params(
            EC::PATH_TRAVERSAL,
            format!("Path contains illegal '..' component: {path}"),
            path_params(path),
        ));
    }

    let windows_absolute = is_windows_absolute_path(path);
    let unix_absolute = path.starts_with('/');
    let platform_mismatch = match host {
        HostPlatform::Windows => unix_absolute && !windows_absolute,
        HostPlatform::Unix => windows_absolute,
    };
    if platform_mismatch {
        let host_name = match host {
            HostPlatform::Windows => "Windows",
            HostPlatform::Unix => "macOS/Linux",
        };
        return Err(AppError::coded_with_params(
            EC::PATH_PLATFORM_MISMATCH,
            format!("Path does not match the {host_name} host: {path}"),
            HashMap::from([
                ("path".into(), path.into()),
                ("platform".into(), host_name.into()),
            ]),
        ));
    }

    let absolute = match host {
        HostPlatform::Windows => windows_absolute,
        HostPlatform::Unix => unix_absolute,
    };
    if !absolute {
        return Err(AppError::coded_with_params(
            EC::PATH_NOT_ABSOLUTE,
            format!("Path must be absolute: {path}"),
            path_params(path),
        ));
    }
    Ok(())
}

fn validate_existing_directory(path: &Path) -> Result<(), AppError> {
    let display = path.to_string_lossy().to_string();
    let metadata = std::fs::metadata(path).map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            EC::PATH_NOT_FOUND
        } else {
            EC::PATH_INACCESSIBLE
        };
        AppError::coded_with_params(
            code,
            format!("Cannot access launch directory {display}: {error}"),
            HashMap::from([
                ("path".into(), display.clone()),
                ("detail".into(), error.to_string()),
            ]),
        )
    })?;
    if !metadata.is_dir() {
        return Err(AppError::coded_with_params(
            EC::PATH_NOT_DIRECTORY,
            format!("Launch path is not a directory: {display}"),
            path_params(&display),
        ));
    }
    Ok(())
}

pub fn validate_launch_cwd(
    project_path: &str,
    workspace_path: Option<&str>,
    runtime: LaunchRuntime,
) -> Result<(), AppError> {
    if runtime == LaunchRuntime::Ssh {
        return Ok(());
    }
    let effective_cwd = workspace_path.unwrap_or(project_path);
    classify_launch_cwd_for_host(effective_cwd, runtime, HostPlatform::current())?;
    validate_existing_directory(Path::new(effective_cwd))
}

pub fn validate_spawn_cwd(path: &Path) -> Result<(), AppError> {
    let display = path.to_string_lossy();
    classify_launch_cwd_for_host(&display, LaunchRuntime::Local, HostPlatform::current())?;
    validate_existing_directory(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_path(kind: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "cc-panes-host-path-{kind}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ))
    }

    #[test]
    fn local_windows_path_is_platform_mismatch_on_unix_host() {
        let error =
            classify_launch_cwd_for_host(r"D:\repo", LaunchRuntime::Local, HostPlatform::Unix)
                .expect_err("Windows path must be rejected on a Unix host");

        assert_eq!(error.code(), Some(EC::PATH_PLATFORM_MISMATCH));
    }

    #[test]
    fn ssh_launch_skips_local_path_classification() {
        assert!(classify_launch_cwd_for_host(
            r"D:\missing\remote-project",
            LaunchRuntime::Ssh,
            HostPlatform::Unix,
        )
        .is_ok());
    }

    #[test]
    fn wsl_launch_is_explicitly_unsupported_on_unix_host() {
        let error = classify_launch_cwd_for_host("/repo", LaunchRuntime::Wsl, HostPlatform::Unix)
            .expect_err("WSL must be rejected before generic path validation");

        assert_eq!(error.code(), Some(EC::WSL_UNSUPPORTED));
    }

    #[test]
    fn spawn_cwd_rejects_missing_directory() {
        let path = temp_test_path("missing");
        let error = validate_spawn_cwd(&path).expect_err("missing cwd must be rejected");

        assert_eq!(error.code(), Some(EC::PATH_NOT_FOUND));
    }

    #[test]
    fn spawn_cwd_rejects_regular_file() {
        let path = temp_test_path("file");
        std::fs::write(&path, b"not a directory").expect("create test file");

        let error = validate_spawn_cwd(&path).expect_err("file cwd must be rejected");
        std::fs::remove_file(&path).expect("remove test file");

        assert_eq!(error.code(), Some(EC::PATH_NOT_DIRECTORY));
    }

    #[test]
    fn spawn_cwd_accepts_existing_directory() {
        let path = temp_test_path("directory");
        std::fs::create_dir(&path).expect("create test directory");

        let result = validate_spawn_cwd(&path);
        std::fs::remove_dir(&path).expect("remove test directory");

        assert!(result.is_ok());
    }
}
