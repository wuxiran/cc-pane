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
    /// `wsl_distro` 是否为默认发行版；本地根恒为 false。
    pub wsl_default_distro: bool,
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
            wsl_default_distro: false,
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
            wsl_default_distro: false,
        });
        roots.push(ScanRoot {
            cli_tool: "pi",
            path: home.join(".pi").join("agent").join("sessions"),
            source: "local",
            wsl_distro: None,
            wsl_default_distro: false,
        });
        roots.push(ScanRoot {
            cli_tool: "omp",
            path: home.join(".omp").join("agent").join("sessions"),
            source: "local",
            wsl_distro: None,
            wsl_default_distro: false,
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
            wsl_default_distro: distro.is_default,
        });
        roots.push(ScanRoot {
            cli_tool: "pi",
            path: PathBuf::from(format!(
                r"\\wsl$\{}\home\{}\.pi\agent\sessions",
                distro.name.trim(),
                user
            )),
            source: "wsl",
            wsl_distro: Some(distro.name.trim().to_string()),
            wsl_default_distro: distro.is_default,
        });
        roots.push(ScanRoot {
            cli_tool: "omp",
            path: PathBuf::from(format!(
                r"\\wsl$\{}\home\{}\.omp\agent\sessions",
                distro.name.trim(),
                user
            )),
            source: "wsl",
            wsl_distro: Some(distro.name.trim().to_string()),
            wsl_default_distro: distro.is_default,
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
    cc_panes_paths::wsl_compare_key(path)
}

/// 按 cwd 找归属项目：取最长前缀匹配，且 WSL 扫描根只认同一发行版的项目。
///
/// 项目没配 distro（`None`）视为默认发行版；本地扫描根不按发行版过滤。
/// 这样两个发行版下的同名 Linux 路径（比较键相同）不会串到对方的项目上。
pub(super) fn match_registered_project<'a>(
    cwd_norm: &str,
    registered: &'a [RegisteredProject],
    root: &ScanRoot,
) -> Option<&'a RegisteredProject> {
    registered
        .iter()
        .filter(|project| project_on_root_distro(project, root))
        .filter(|project| path_has_prefix(cwd_norm, &project.match_path_norm))
        .max_by_key(|project| project.match_path_norm.len())
}

fn project_on_root_distro(project: &RegisteredProject, root: &ScanRoot) -> bool {
    if root.source != "wsl" {
        return true;
    }
    match (project.wsl_distro.as_deref(), root.wsl_distro.as_deref()) {
        (Some(project), Some(root)) => project.trim().eq_ignore_ascii_case(root.trim()),
        (None, Some(_)) => root.wsl_default_distro,
        (_, None) => true,
    }
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
    use super::{
        collect_scan_roots, match_registered_project, normalize_path, RegisteredProject, ScanRoot,
    };
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
    fn periodic_scan_includes_running_wsl_cli_roots_only_when_allowed() {
        let roots = collect_scan_roots(&[running_distro()], true);
        let codex = roots
            .iter()
            .find(|root| root.source == "wsl" && root.cli_tool == "codex")
            .expect("WSL Codex root");
        let pi = roots
            .iter()
            .find(|root| root.source == "wsl" && root.cli_tool == "pi")
            .expect("WSL Pi root");
        let omp = roots
            .iter()
            .find(|root| root.source == "wsl" && root.cli_tool == "omp")
            .expect("WSL Oh My Pi root");
        assert_eq!(codex.wsl_distro.as_deref(), Some("Ubuntu"));
        assert_eq!(pi.wsl_distro.as_deref(), Some("Ubuntu"));
        assert_eq!(omp.wsl_distro.as_deref(), Some("Ubuntu"));
        assert!(omp
            .path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with(".omp/agent/sessions"));
    }

    #[test]
    fn local_scan_includes_pi_agent_sessions() {
        let roots = collect_scan_roots(&[], false);
        let pi = roots
            .iter()
            .find(|root| root.source == "local" && root.cli_tool == "pi")
            .expect("local Pi root");
        assert!(pi.path.ends_with(".pi/agent/sessions"));
        let omp = roots
            .iter()
            .find(|root| root.source == "local" && root.cli_tool == "omp")
            .expect("local Oh My Pi root");
        assert!(omp.path.ends_with(".omp/agent/sessions"));
    }

    fn wsl_root(distro: &str, is_default: bool) -> ScanRoot {
        ScanRoot {
            cli_tool: "codex",
            path: std::path::PathBuf::from("rollouts"),
            source: "wsl",
            wsl_distro: Some(distro.to_string()),
            wsl_default_distro: is_default,
        }
    }

    fn project(path: &str, name: &str, distro: Option<&str>) -> RegisteredProject {
        RegisteredProject {
            match_path_norm: normalize_path(path),
            project_path_norm: normalize_path(path),
            project_name: name.to_string(),
            workspace_name: "ws".to_string(),
            wsl_distro: distro.map(str::to_string),
        }
    }

    #[test]
    fn drive_mnt_and_unc_forms_share_one_key() {
        let key = normalize_path(r"D:\Foo");
        assert_eq!(normalize_path("/mnt/d/Foo"), key);
        assert_eq!(normalize_path(r"\\wsl.localhost\Ubuntu\mnt\d\foo"), key);
        assert_eq!(
            normalize_path(r"\\wsl.localhost\Ubuntu\home\u\x"),
            normalize_path("/home/u/x")
        );
        assert_ne!(normalize_path("/home/u/Foo"), normalize_path("/home/u/foo"));
    }

    #[test]
    fn wsl_attribution_does_not_cross_distros() {
        let registered = vec![
            project(
                r"\\wsl.localhost\Ubuntu\home\u\x",
                "ubuntu-x",
                Some("Ubuntu"),
            ),
            project(
                r"\\wsl.localhost\Debian\home\u\x",
                "debian-x",
                Some("Debian"),
            ),
        ];
        let cwd = normalize_path("/home/u/x/src");

        let ubuntu = match_registered_project(&cwd, &registered, &wsl_root("Ubuntu", true));
        let debian = match_registered_project(&cwd, &registered, &wsl_root("Debian", false));
        let other = match_registered_project(&cwd, &registered, &wsl_root("Arch", false));

        assert_eq!(ubuntu.map(|p| p.project_name.as_str()), Some("ubuntu-x"));
        assert_eq!(debian.map(|p| p.project_name.as_str()), Some("debian-x"));
        assert!(other.is_none());
    }

    #[test]
    fn project_without_distro_belongs_to_default_distro_only() {
        let registered = vec![project(r"D:\Repo", "repo", None)];
        let cwd = normalize_path("/mnt/d/repo");

        assert!(match_registered_project(&cwd, &registered, &wsl_root("Ubuntu", true)).is_some());
        assert!(match_registered_project(&cwd, &registered, &wsl_root("Debian", false)).is_none());
    }

    #[test]
    fn local_roots_are_not_filtered_by_distro() {
        let registered = vec![project(r"D:\Repo", "repo", Some("Ubuntu"))];
        let local = ScanRoot {
            cli_tool: "claude",
            path: std::path::PathBuf::from("projects"),
            source: "local",
            wsl_distro: None,
            wsl_default_distro: false,
        };
        let cwd = normalize_path(r"d:\repo\sub");
        assert!(match_registered_project(&cwd, &registered, &local).is_some());
    }
}
