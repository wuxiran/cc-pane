use crate::models::{CreateSessionRequest, WslLaunchInfo};

pub fn normalize_session_request_for_current_host(
    request: CreateSessionRequest,
) -> CreateSessionRequest {
    normalize_session_request_for_host(request, running_under_wsl())
}

pub fn normalize_session_request_for_host(
    mut request: CreateSessionRequest,
    running_under_wsl: bool,
) -> CreateSessionRequest {
    if !running_under_wsl || request.ssh.is_some() {
        return request;
    }

    if let Some(wsl) = request.wsl.take() {
        let project_path = non_empty(&wsl.remote_path)
            .map(expand_home_path)
            .unwrap_or_else(|| {
                normalize_path_for_wsl(&request.project_path).unwrap_or(request.project_path)
            });
        request.workspace_path =
            normalize_workspace_path_for_wsl(request.workspace_path.take(), &project_path, &wsl);
        request.project_path = project_path;
        return request;
    }

    request.project_path =
        normalize_path_for_wsl(&request.project_path).unwrap_or(request.project_path);
    request.workspace_path = request
        .workspace_path
        .take()
        .map(|path| normalize_path_for_wsl(&path).unwrap_or(path));
    request
}

fn normalize_workspace_path_for_wsl(
    workspace_path: Option<String>,
    project_path: &str,
    wsl: &WslLaunchInfo,
) -> Option<String> {
    if let Some(remote_path) = wsl.workspace_remote_path.as_deref().and_then(non_empty) {
        return Some(expand_home_path(remote_path));
    }

    let workspace_path = workspace_path?;
    let normalized = normalize_path_for_wsl(&workspace_path).unwrap_or(workspace_path);
    if is_same_or_parent_path(&normalized, project_path) {
        Some(normalized)
    } else {
        None
    }
}

fn normalize_path_for_wsl(path: &str) -> Option<String> {
    windows_drive_path_to_wsl(path).or_else(|| wsl_unc_path_to_posix(path))
}

fn windows_drive_path_to_wsl(path: &str) -> Option<String> {
    let normalized = path.trim().trim_matches('"').replace('\\', "/");
    let path = normalized
        .strip_prefix("//?/")
        .or_else(|| normalized.strip_prefix("//./"))
        .unwrap_or(&normalized);
    let bytes = path.as_bytes();
    if bytes.len() < 2 || bytes[1] != b':' {
        return None;
    }

    let drive = (bytes[0] as char).to_ascii_lowercase();
    if !drive.is_ascii_alphabetic() {
        return None;
    }

    let rest = path[2..].trim_start_matches('/');
    if rest.is_empty() {
        Some(format!("/mnt/{drive}"))
    } else {
        Some(format!("/mnt/{drive}/{rest}"))
    }
}

fn wsl_unc_path_to_posix(path: &str) -> Option<String> {
    let normalized = path.trim().trim_matches('"').replace('\\', "/");
    let without_slashes = normalized.trim_start_matches('/');
    let lower = without_slashes.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("wsl.localhost/")
        .or_else(|| lower.strip_prefix("wsl$/"))
        .or_else(|| lower.strip_prefix("wsl/"))?;

    let host_prefix_len = without_slashes.len() - rest.len();
    let rest_original = &without_slashes[host_prefix_len..];
    let mut parts = rest_original.splitn(2, '/');
    let distro = parts.next().unwrap_or_default();
    if distro.trim().is_empty() {
        return None;
    }
    let remote_path = parts.next().unwrap_or_default().trim_start_matches('/');
    if remote_path.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{remote_path}"))
    }
}

fn expand_home_path(path: &str) -> String {
    let path = path.trim();
    if path == "~" {
        return dirs::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|home| home.join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
    }
    path.to_string()
}

fn is_same_or_parent_path(parent: &str, child: &str) -> bool {
    let parent = parent.trim_end_matches('/');
    let child = child.trim_end_matches('/');
    if parent.is_empty() || child.is_empty() {
        return false;
    }
    if parent == "/" {
        return child.starts_with('/');
    }
    child == parent || child.starts_with(&format!("{parent}/"))
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn running_under_wsl() -> bool {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|release| {
            let release = release.to_ascii_lowercase();
            release.contains("microsoft") || release.contains("wsl")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use crate::models::{CliTool, LaunchProviderSelection};

    use super::*;

    fn request(project_path: &str) -> CreateSessionRequest {
        CreateSessionRequest {
            launch_id: None,
            project_path: project_path.to_string(),
            cols: 120,
            rows: 30,
            workspace_name: Some("workspace".to_string()),
            provider_id: None,
            provider_selection: LaunchProviderSelection::Inherit,
            launch_profile_id: None,
            workspace_path: None,
            workspace_snapshot_id: None,
            launch_claude: false,
            cli_tool: CliTool::Claude,
            resume_id: None,
            skip_mcp: false,
            append_system_prompt: None,
            initial_prompt: None,
            yolo_mode: None,
            adapter_options: None,
            extra_env: None,
            ssh: None,
            wsl: None,
        }
    }

    #[test]
    fn preserves_wsl_launch_on_non_wsl_host() {
        let mut req = request("D:/workspace/repo");
        req.workspace_path = Some("D:/workspace".to_string());
        req.wsl = Some(WslLaunchInfo {
            remote_path: "/mnt/d/workspace/repo".to_string(),
            workspace_remote_path: Some("/mnt/d/workspace".to_string()),
            distro: Some("Ubuntu".to_string()),
        });

        let normalized = normalize_session_request_for_host(req, false);

        assert!(normalized.wsl.is_some());
        assert_eq!(normalized.project_path, "D:/workspace/repo");
        assert_eq!(normalized.workspace_path.as_deref(), Some("D:/workspace"));
    }

    #[test]
    fn converts_wsl_launch_to_local_paths_when_web_runs_inside_wsl() {
        let mut req = request("D:/workspace/repo");
        req.workspace_path = Some("D:/workspace".to_string());
        req.wsl = Some(WslLaunchInfo {
            remote_path: "/mnt/d/workspace/repo".to_string(),
            workspace_remote_path: Some("/mnt/d/workspace".to_string()),
            distro: Some("Ubuntu".to_string()),
        });

        let normalized = normalize_session_request_for_host(req, true);

        assert!(normalized.wsl.is_none());
        assert_eq!(normalized.project_path, "/mnt/d/workspace/repo");
        assert_eq!(
            normalized.workspace_path.as_deref(),
            Some("/mnt/d/workspace")
        );
    }

    #[test]
    fn clears_windows_workspace_path_when_it_is_not_the_wsl_parent() {
        let mut req = request("D:/workspace/repo");
        req.workspace_path = Some("D:/workspace".to_string());
        req.wsl = Some(WslLaunchInfo {
            remote_path: "/home/dev/repo".to_string(),
            workspace_remote_path: None,
            distro: Some("Ubuntu".to_string()),
        });

        let normalized = normalize_session_request_for_host(req, true);

        assert_eq!(normalized.project_path, "/home/dev/repo");
        assert!(normalized.workspace_path.is_none());
        assert!(normalized.wsl.is_none());
    }

    #[test]
    fn converts_local_windows_paths_when_web_runs_inside_wsl() {
        let mut req = request("D:\\workspace\\repo");
        req.workspace_path = Some("D:\\workspace".to_string());

        let normalized = normalize_session_request_for_host(req, true);

        assert_eq!(normalized.project_path, "/mnt/d/workspace/repo");
        assert_eq!(
            normalized.workspace_path.as_deref(),
            Some("/mnt/d/workspace")
        );
    }

    #[test]
    fn converts_wsl_unc_paths_to_posix_paths() {
        assert_eq!(
            normalize_path_for_wsl(r#"\\wsl.localhost\Ubuntu\home\dev\repo"#).as_deref(),
            Some("/home/dev/repo")
        );
    }
}
