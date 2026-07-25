use crate::models::{Workspace, WslDistro, WslDistroState};
use crate::services::WorkspaceService;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

#[derive(Debug, Clone)]
pub(super) struct ScanRoot {
    pub cli_tool: &'static str,
    pub path: PathBuf,
    pub source: &'static str,
    pub wsl_distro: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct RegisteredProject {
    pub match_path_norm: String,
    pub project_path_norm: String,
    pub project_name: String,
    pub workspace_name: String,
    pub wsl_distro: Option<String>,
}

pub(super) fn collect_scan_roots(wsl_distros: &[WslDistro], wsl_allowed: bool) -> Vec<ScanRoot> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(ScanRoot {
            cli_tool: "claude",
            path: home.join(".claude").join("projects"),
            source: "local",
            wsl_distro: None,
        });
        let codex_root = std::env::var_os("CODEX_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        roots.push(ScanRoot {
            cli_tool: "codex",
            path: codex_root.join("sessions"),
            source: "local",
            wsl_distro: None,
        });
    }
    if !wsl_allowed {
        return roots;
    }
    for distro in wsl_distros {
        let Some(user) = distro
            .default_user
            .as_deref()
            .map(str::trim)
            .filter(|user| !user.is_empty())
        else {
            continue;
        };
        if distro.state != WslDistroState::Running || distro.name.trim().is_empty() {
            continue;
        }
        roots.push(ScanRoot {
            cli_tool: "codex",
            path: PathBuf::from(format!(
                r"\\wsl$\{}\home\{}\.codex\sessions",
                distro.name.trim(),
                user
            )),
            source: "wsl",
            wsl_distro: Some(distro.name.trim().to_string()),
        });
    }
    roots
}

pub(super) fn collect_jsonl_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_jsonl_files_inner(root, &mut files);
    files
}

fn collect_jsonl_files_inner(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files_inner(&path, files);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

pub(super) fn registered_projects(workspace_service: &WorkspaceService) -> Vec<RegisteredProject> {
    let workspaces = match workspace_service.list_workspaces() {
        Ok(workspaces) => workspaces,
        Err(error) => {
            warn!(err = %error, "Failed to list workspaces for session index attribution");
            return Vec::new();
        }
    };
    workspaces
        .iter()
        .flat_map(registered_projects_for_workspace)
        .collect()
}

fn registered_projects_for_workspace(workspace: &Workspace) -> Vec<RegisteredProject> {
    workspace
        .projects
        .iter()
        .flat_map(|project| {
            let canonical = normalize_path(&project.path);
            let project_name = project
                .alias
                .clone()
                .unwrap_or_else(|| path_name(&project.path));
            let wsl_distro = workspace.wsl.as_ref().and_then(|wsl| wsl.distro.clone());
            let base = RegisteredProject {
                match_path_norm: canonical.clone(),
                project_path_norm: canonical.clone(),
                project_name: project_name.clone(),
                workspace_name: workspace.name.clone(),
                wsl_distro: wsl_distro.clone(),
            };
            let mut variants = vec![base];
            if let Some(remote) = project.wsl_remote_path.as_deref() {
                variants.push(RegisteredProject {
                    match_path_norm: normalize_path(remote),
                    project_path_norm: canonical,
                    project_name,
                    workspace_name: workspace.name.clone(),
                    wsl_distro,
                });
            }
            variants
        })
        .collect()
}

pub(super) fn normalize_path(path: &str) -> String {
    super::codex_session_service::normalize_cross_platform_compare_path(path.trim())
}

pub(super) fn path_has_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || (!prefix.is_empty()
            && path
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('/')))
}

pub(super) fn path_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::collect_scan_roots;
    use crate::models::{WslDistro, WslDistroState};

    fn running_distro() -> WslDistro {
        WslDistro {
            name: "Ubuntu".to_string(),
            state: WslDistroState::Running,
            wsl_version: 2,
            is_default: true,
            default_user: Some("tester".to_string()),
            already_imported: false,
        }
    }

    #[test]
    fn startup_gate_excludes_wsl_roots_even_when_cache_says_running() {
        let roots = collect_scan_roots(&[running_distro()], false);
        assert!(roots.iter().all(|root| root.source == "local"));
    }

    #[test]
    fn periodic_scan_includes_running_wsl_codex_only_when_allowed() {
        let roots = collect_scan_roots(&[running_distro()], true);
        let wsl = roots
            .iter()
            .find(|root| root.source == "wsl")
            .expect("WSL root");
        assert_eq!(wsl.cli_tool, "codex");
        assert_eq!(wsl.wsl_distro.as_deref(), Some("Ubuntu"));
    }
}
