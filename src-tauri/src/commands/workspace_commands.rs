use crate::models::{
    ProjectMigrationPlan, ProjectMigrationRequest, ProjectMigrationResult,
    ProjectMigrationRollbackResult, ScannedRepo, SshConnectionInfo, Workspace,
    WorkspaceMigrationPlan, WorkspaceMigrationRequest, WorkspaceMigrationResult,
    WorkspaceMigrationRollbackResult, WorkspaceProject,
};
use crate::services::{HistoryWatchManager, WorkspaceService};
use crate::utils::{validate_path, validate_ssh_info, AppError, AppResult};
use cc_panes_core::utils::{normalize_project_path, paths_equivalent};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn list_workspaces(service: State<'_, Arc<WorkspaceService>>) -> AppResult<Vec<Workspace>> {
    Ok(service.list_workspaces()?)
}

#[tauri::command]
pub fn create_workspace(
    name: String,
    path: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<Workspace> {
    debug!(name = %name, "cmd::create_workspace");
    if let Some(ref p) = path {
        validate_path(p)?;
    }
    Ok(service.create_workspace(&name, path.as_deref())?)
}

#[tauri::command]
pub fn get_workspace(
    name: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<Workspace> {
    Ok(service.get_workspace(&name)?)
}

#[tauri::command]
pub fn rename_workspace(
    old_name: String,
    new_name: String,
    service: State<'_, Arc<WorkspaceService>>,
    history_watch_manager: State<'_, Arc<HistoryWatchManager>>,
) -> AppResult<()> {
    debug!(old_name = %old_name, new_name = %new_name, "cmd::rename_workspace");
    let workspace = service.get_workspace(&old_name)?;
    let old_workspace_dir = service.workspace_dir(&old_name);
    for project in &workspace.projects {
        if path_is_within(Path::new(&project.path), &old_workspace_dir) {
            history_watch_manager.force_stop_project(&project.path);
        }
    }
    Ok(service.rename_workspace(&old_name, &new_name)?)
}

#[tauri::command]
pub fn delete_workspace(
    name: String,
    service: State<'_, Arc<WorkspaceService>>,
    history_watch_manager: State<'_, Arc<HistoryWatchManager>>,
) -> AppResult<()> {
    debug!(name = %name, "cmd::delete_workspace");
    let removed_paths: Vec<String> = service
        .get_workspace(&name)?
        .projects
        .into_iter()
        .map(|project| project.path)
        .collect();
    service.delete_workspace(&name)?;
    let remaining = service.list_workspaces()?;
    for path in removed_paths {
        if !workspaces_reference_path(&remaining, &path) {
            history_watch_manager.force_stop_project(path);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn add_workspace_project(
    workspace_name: String,
    path: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<WorkspaceProject> {
    debug!(workspace_name = %workspace_name, path = %path, "cmd::add_workspace_project");
    service
        .add_project(&workspace_name, &path)
        .map_err(|error| project_add_error(error, &path))
}

fn project_add_error(error: String, path: &str) -> AppError {
    if error.starts_with("PROJECT_ALREADY_EXISTS:") {
        return AppError::coded_with_params(
            "PROJECT_ALREADY_EXISTS",
            error,
            HashMap::from([("path".to_string(), path.to_string())]),
        );
    }
    AppError::from(error)
}

#[tauri::command]
pub fn add_ssh_project(
    workspace_name: String,
    ssh_info: SshConnectionInfo,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<WorkspaceProject> {
    debug!(workspace_name = %workspace_name, host = %ssh_info.host, "cmd::add_ssh_project");
    validate_ssh_info(&ssh_info)?;
    Ok(service.add_ssh_project(&workspace_name, ssh_info)?)
}

#[tauri::command]
pub fn remove_workspace_project(
    workspace_name: String,
    project_id: String,
    service: State<'_, Arc<WorkspaceService>>,
    history_watch_manager: State<'_, Arc<HistoryWatchManager>>,
) -> AppResult<()> {
    debug!(workspace_name = %workspace_name, project_id = %project_id, "cmd::remove_workspace_project");
    let project_path = service
        .get_workspace(&workspace_name)?
        .projects
        .into_iter()
        .find(|project| project.id == project_id)
        .map(|project| project.path)
        .ok_or_else(|| format!("Project '{}' does not exist", project_id))?;
    service.remove_project(&workspace_name, &project_id)?;
    if !workspaces_reference_path(&service.list_workspaces()?, &project_path) {
        history_watch_manager.force_stop_project(project_path);
    }
    Ok(())
}

#[tauri::command]
pub fn update_workspace_alias(
    workspace_name: String,
    alias: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(workspace_name = %workspace_name, "cmd::update_workspace_alias");
    Ok(service.update_workspace_alias(&workspace_name, alias.as_deref())?)
}

#[tauri::command]
pub fn update_workspace_project_alias(
    workspace_name: String,
    project_id: String,
    alias: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(workspace_name = %workspace_name, project_id = %project_id, "cmd::update_workspace_project_alias");
    Ok(service.update_project_alias(&workspace_name, &project_id, alias.as_deref())?)
}

#[tauri::command]
pub fn update_workspace_provider(
    workspace_name: String,
    provider_id: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(workspace_name = %workspace_name, "cmd::update_workspace_provider");
    Ok(service.update_workspace_provider(&workspace_name, provider_id.as_deref())?)
}

#[tauri::command]
pub fn update_workspace_path(
    workspace_name: String,
    path: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(workspace_name = %workspace_name, "cmd::update_workspace_path");
    if let Some(ref p) = path {
        validate_path(p)?;
    }
    Ok(service.update_workspace_path(&workspace_name, path.as_deref())?)
}

#[tauri::command]
pub fn update_workspace(
    name: String,
    workspace: Workspace,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(name = %name, "cmd::update_workspace");
    Ok(service.write_workspace_json(&name, &workspace)?)
}

#[tauri::command]
pub fn reorder_workspaces(
    ordered_names: Vec<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!("cmd::reorder_workspaces");
    Ok(service.reorder_workspaces(ordered_names)?)
}

#[tauri::command]
pub fn scan_workspace_directory(root_path: String) -> AppResult<Vec<ScannedRepo>> {
    validate_path(&root_path)?;
    Ok(WorkspaceService::scan_directory(Path::new(&root_path))?)
}

#[tauri::command]
pub async fn preview_workspace_migration(
    request: WorkspaceMigrationRequest,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<WorkspaceMigrationPlan> {
    debug!(workspace = %request.workspace_name, "cmd::preview_workspace_migration");
    let svc = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || svc.preview_workspace_migration(&request))
        .await
        .map_err(|e| {
            crate::utils::AppError::from(format!("Failed to preview workspace migration: {}", e))
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn execute_workspace_migration(
    request: WorkspaceMigrationRequest,
    service: State<'_, Arc<WorkspaceService>>,
    history_watch_manager: State<'_, Arc<HistoryWatchManager>>,
) -> AppResult<WorkspaceMigrationResult> {
    debug!(workspace = %request.workspace_name, "cmd::execute_workspace_migration");
    let svc = service.inner().clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || svc.execute_workspace_migration(&request))
            .await
            .map_err(|e| {
                crate::utils::AppError::from(format!(
                    "Failed to execute workspace migration: {}",
                    e
                ))
            })??;
    for item in &result.plan.items {
        history_watch_manager.force_stop_project(&item.source_path);
    }
    Ok(result)
}

#[tauri::command]
pub async fn rollback_workspace_migration(
    workspace_name: String,
    snapshot_id: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<WorkspaceMigrationRollbackResult> {
    debug!(workspace = %workspace_name, snapshot_id = %snapshot_id, "cmd::rollback_workspace_migration");
    let svc = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        svc.rollback_workspace_migration(&workspace_name, &snapshot_id)
    })
    .await
    .map_err(|e| {
        crate::utils::AppError::from(format!("Failed to rollback workspace migration: {}", e))
    })?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn preview_project_migration(
    request: ProjectMigrationRequest,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<ProjectMigrationPlan> {
    debug!(
        workspace = %request.workspace_name,
        project = %request.project_id,
        "cmd::preview_project_migration"
    );
    let svc = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || svc.preview_project_migration(&request))
        .await
        .map_err(|e| {
            crate::utils::AppError::from(format!("Failed to preview project migration: {}", e))
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn execute_project_migration(
    request: ProjectMigrationRequest,
    service: State<'_, Arc<WorkspaceService>>,
    history_watch_manager: State<'_, Arc<HistoryWatchManager>>,
) -> AppResult<ProjectMigrationResult> {
    debug!(
        workspace = %request.workspace_name,
        project = %request.project_id,
        "cmd::execute_project_migration"
    );
    let svc = service.inner().clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || svc.execute_project_migration(&request))
            .await
            .map_err(|e| {
                crate::utils::AppError::from(format!("Failed to execute project migration: {}", e))
            })??;
    history_watch_manager.force_stop_project(&result.plan.source_path);
    Ok(result)
}

fn workspaces_reference_path(workspaces: &[Workspace], path: &str) -> bool {
    workspaces.iter().any(|workspace| {
        workspace
            .projects
            .iter()
            .any(|project| paths_equivalent(&project.path, path))
    })
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    let path = normalize_project_path(path);
    let root = normalize_project_path(root);
    path.ancestors()
        .any(|ancestor| paths_equivalent(ancestor, &root))
}

#[tauri::command]
pub async fn rollback_project_migration(
    workspace_name: String,
    snapshot_id: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<ProjectMigrationRollbackResult> {
    debug!(
        workspace = %workspace_name,
        snapshot_id = %snapshot_id,
        "cmd::rollback_project_migration"
    );
    let svc = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        svc.rollback_project_migration(&workspace_name, &snapshot_id)
    })
    .await
    .map_err(|e| {
        crate::utils::AppError::from(format!("Failed to rollback project migration: {}", e))
    })?
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::{path_is_within, project_add_error, workspaces_reference_path};
    use crate::models::{Workspace, WorkspaceProject};
    use std::path::Path;

    fn workspace(name: &str, paths: &[&str]) -> Workspace {
        let mut workspace = Workspace::new(name.to_string(), None);
        workspace.projects = paths
            .iter()
            .enumerate()
            .map(|(index, path)| WorkspaceProject {
                id: format!("p-{index}"),
                path: (*path).to_string(),
                alias: None,
                launch_profile_id: None,
                wsl_remote_path: None,
                ssh: None,
            })
            .collect();
        workspace
    }

    #[test]
    fn workspace_reference_check_uses_shared_path_equivalence() {
        let workspaces = vec![
            workspace("a", &["D:/Code/App"]),
            workspace("b", &["/tmp/b"]),
        ];

        assert!(workspaces_reference_path(&workspaces, r"d:\code\app\"));
        assert!(!workspaces_reference_path(&workspaces, r"D:\Code\Other"));
    }

    #[test]
    fn duplicate_project_error_keeps_translatable_code_and_path() {
        let error = project_add_error(
            "PROJECT_ALREADY_EXISTS: duplicate".to_string(),
            "/mnt/d/repos/app",
        );
        assert_eq!(error.code(), Some("PROJECT_ALREADY_EXISTS"));
        assert_eq!(
            error
                .params()
                .and_then(|params| params.get("path"))
                .map(String::as_str),
            Some("/mnt/d/repos/app")
        );
    }

    #[test]
    fn path_prefix_check_is_component_aware() {
        assert!(path_is_within(
            Path::new("/data/workspaces/old/project"),
            Path::new("/data/workspaces/old")
        ));
        assert!(path_is_within(
            Path::new("/data/workspaces/old"),
            Path::new("/data/workspaces/old")
        ));
        assert!(!path_is_within(
            Path::new("/data/workspaces/old-copy/project"),
            Path::new("/data/workspaces/old")
        ));
    }
}
