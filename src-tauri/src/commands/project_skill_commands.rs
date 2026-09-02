//! Agent Skills that CC-Panes owns per scope — project folders (`<repo>/<root>/<name>`) and
//! workspace folders (`<workspace>/skills/skills/<name>`). Slash commands stay in
//! `skill_commands.rs`; user-level installs stay with the skill market.

use crate::services::{SkillMarketEntry, SkillMarketService};
use crate::utils::{validate_path, AppError, AppResult};
use cc_panes_core::services::{
    ExternalSkillRegistry, ProjectSkill, ProjectSkillContent, ProjectSkillRoot,
    ProjectSkillService, UserSkillService, WorkspaceSkillService,
};
use cc_panes_core::utils::AppPaths;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

// ───────────────────────── project scope ─────────────────────────

#[tauri::command]
pub fn list_project_skill_roots() -> Vec<ProjectSkillRoot> {
    ProjectSkillService::roots().to_vec()
}

#[tauri::command]
pub fn list_project_skills(
    project_path: String,
    service: State<'_, Arc<ProjectSkillService>>,
) -> AppResult<Vec<ProjectSkill>> {
    validate_path(&project_path)?;
    service.list(&project_path)
}

#[tauri::command]
pub fn read_project_skill(
    project_path: String,
    root: String,
    rel_dir: String,
    service: State<'_, Arc<ProjectSkillService>>,
) -> AppResult<Option<ProjectSkillContent>> {
    validate_path(&project_path)?;
    service.read(&project_path, &root, &rel_dir)
}

#[tauri::command]
pub fn save_project_skill(
    project_path: String,
    root: String,
    name: String,
    content: String,
    service: State<'_, Arc<ProjectSkillService>>,
) -> AppResult<ProjectSkill> {
    debug!(project_path = %project_path, root = %root, name = %name, "cmd::save_project_skill");
    validate_path(&project_path)?;
    service.save(&project_path, &root, &name, &content)
}

#[tauri::command]
pub fn delete_project_skill(
    project_path: String,
    root: String,
    rel_dir: String,
    service: State<'_, Arc<ProjectSkillService>>,
) -> AppResult<bool> {
    debug!(project_path = %project_path, root = %root, rel_dir = %rel_dir, "cmd::delete_project_skill");
    validate_path(&project_path)?;
    service.delete(&project_path, &root, &rel_dir)
}

#[tauri::command]
pub fn move_project_skill(
    project_path: String,
    root: String,
    rel_dir: String,
    to_root: String,
    service: State<'_, Arc<ProjectSkillService>>,
) -> AppResult<ProjectSkill> {
    debug!(project_path = %project_path, root = %root, rel_dir = %rel_dir, to_root = %to_root, "cmd::move_project_skill");
    validate_path(&project_path)?;
    service.move_to_root(&project_path, &root, &rel_dir, &to_root)
}

// ───────────────────────── workspace scope ─────────────────────────

#[tauri::command]
pub fn list_workspace_skills(
    workspace_name: String,
    service: State<'_, Arc<WorkspaceSkillService>>,
) -> AppResult<Vec<ProjectSkill>> {
    service.list(&workspace_name)
}

#[tauri::command]
pub fn read_workspace_skill(
    workspace_name: String,
    rel_dir: String,
    service: State<'_, Arc<WorkspaceSkillService>>,
) -> AppResult<Option<ProjectSkillContent>> {
    service.read(&workspace_name, &rel_dir)
}

#[tauri::command]
pub fn save_workspace_skill(
    workspace_name: String,
    name: String,
    content: String,
    service: State<'_, Arc<WorkspaceSkillService>>,
) -> AppResult<ProjectSkill> {
    debug!(workspace = %workspace_name, name = %name, "cmd::save_workspace_skill");
    service.save(&workspace_name, &name, &content)
}

#[tauri::command]
pub fn delete_workspace_skill(
    workspace_name: String,
    rel_dir: String,
    service: State<'_, Arc<WorkspaceSkillService>>,
) -> AppResult<bool> {
    debug!(workspace = %workspace_name, rel_dir = %rel_dir, "cmd::delete_workspace_skill");
    service.delete(&workspace_name, &rel_dir)
}

// ───────────────────────── import (both scopes) ─────────────────────────

/// Where an imported skill folder comes from.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectSkillImportSource {
    /// `~/.cc-panes/skills/user/<id>` (installed from the market or elsewhere).
    User { id: String },
    /// A skill discovered in a CLI home (`claude:<name>`, `codex:<name>`, `plugin:<id>:<name>`).
    External { id: String },
    /// Another registered project's skill folder.
    #[serde(rename_all = "camelCase")]
    Project {
        project_path: String,
        root: String,
        rel_dir: String,
    },
    /// A workspace's skill folder.
    #[serde(rename_all = "camelCase")]
    Workspace {
        workspace_name: String,
        rel_dir: String,
    },
    /// Download straight from the skill market.
    Market { entry: Box<SkillMarketEntry> },
}

/// Where the imported folder lands.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkillImportTarget {
    #[serde(rename_all = "camelCase")]
    Project { project_path: String, root: String },
    #[serde(rename_all = "camelCase")]
    Workspace { workspace_name: String },
}

/// A resolved source: either a folder to copy, or a market entry to download.
enum ResolvedSource {
    Folder { dir: PathBuf, default_name: String },
    Market { entry: Box<SkillMarketEntry> },
}

struct SkillServices<'a> {
    project: &'a ProjectSkillService,
    workspace: &'a WorkspaceSkillService,
    external: &'a ExternalSkillRegistry,
    app_paths: &'a AppPaths,
}

fn resolve_source(
    source: ProjectSkillImportSource,
    services: &SkillServices<'_>,
) -> AppResult<ResolvedSource> {
    Ok(match source {
        ProjectSkillImportSource::User { id } => {
            let dir = UserSkillService::skill_dir_for(&services.app_paths.user_skills_dir(), &id)?;
            ResolvedSource::Folder {
                dir,
                default_name: id,
            }
        }
        ProjectSkillImportSource::External { id } => {
            let skill = services
                .external
                .get(&id)?
                .ok_or_else(|| AppError::from(format!("External skill '{}' not found", id)))?;
            let dir = skill_dir_of(&skill.path)?;
            let default_name = leaf_name(&dir);
            ResolvedSource::Folder { dir, default_name }
        }
        ProjectSkillImportSource::Project {
            project_path,
            root,
            rel_dir,
        } => {
            validate_path(&project_path)?;
            let skill = services.project.describe(&project_path, &root, &rel_dir)?;
            let dir = PathBuf::from(&skill.dir_path);
            let default_name = leaf_name(&dir);
            ResolvedSource::Folder { dir, default_name }
        }
        ProjectSkillImportSource::Workspace {
            workspace_name,
            rel_dir,
        } => {
            let skill = services.workspace.describe(&workspace_name, &rel_dir)?;
            let dir = PathBuf::from(&skill.dir_path);
            let default_name = leaf_name(&dir);
            ResolvedSource::Folder { dir, default_name }
        }
        ProjectSkillImportSource::Market { entry } => ResolvedSource::Market { entry },
    })
}

async fn import_into(
    target: SkillImportTarget,
    source: ResolvedSource,
    name: Option<String>,
    overwrite: bool,
    services: &SkillServices<'_>,
    market: &SkillMarketService,
) -> AppResult<ProjectSkill> {
    match (target, source) {
        (
            SkillImportTarget::Project { project_path, root },
            ResolvedSource::Folder { dir, default_name },
        ) => {
            validate_path(&project_path)?;
            let name = name.unwrap_or(default_name);
            services
                .project
                .import_dir(&project_path, &root, &name, &dir, overwrite)
        }
        (SkillImportTarget::Project { project_path, root }, ResolvedSource::Market { entry }) => {
            validate_path(&project_path)?;
            let name = name.unwrap_or_else(|| entry.repo_skill_leaf());
            let target_dir = services.project.target_dir(&project_path, &root, &name)?;
            refuse_existing(&target_dir, &name, overwrite)?;
            market.install_entry_to_dir(&entry, &target_dir).await?;
            services.project.describe(&project_path, &root, &name)
        }
        (
            SkillImportTarget::Workspace { workspace_name },
            ResolvedSource::Folder { dir, default_name },
        ) => {
            let name = name.unwrap_or(default_name);
            services
                .workspace
                .import_dir(&workspace_name, &name, &dir, overwrite)
        }
        (SkillImportTarget::Workspace { workspace_name }, ResolvedSource::Market { entry }) => {
            let name = name.unwrap_or_else(|| entry.repo_skill_leaf());
            let target_dir = services.workspace.target_dir(&workspace_name, &name)?;
            refuse_existing(&target_dir, &name, overwrite)?;
            market.install_entry_to_dir(&entry, &target_dir).await?;
            services
                .workspace
                .finalize_external_write(&workspace_name)?;
            services.workspace.describe(&workspace_name, &name)
        }
    }
}

/// Import into a project root. Kept for callers that predate `import_skill`.
/// Tauri commands take one `State` per service; that is the argument count, not complexity.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn import_project_skill(
    project_path: String,
    root: String,
    name: Option<String>,
    source: ProjectSkillImportSource,
    overwrite: Option<bool>,
    service: State<'_, Arc<ProjectSkillService>>,
    workspace_service: State<'_, Arc<WorkspaceSkillService>>,
    market: State<'_, Arc<SkillMarketService>>,
    external: State<'_, Arc<ExternalSkillRegistry>>,
    app_paths: State<'_, Arc<AppPaths>>,
) -> AppResult<ProjectSkill> {
    debug!(project_path = %project_path, root = %root, source = ?source, "cmd::import_project_skill");
    let services = SkillServices {
        project: &service,
        workspace: &workspace_service,
        external: &external,
        app_paths: &app_paths,
    };
    let resolved = resolve_source(source, &services)?;
    import_into(
        SkillImportTarget::Project { project_path, root },
        resolved,
        name,
        overwrite.unwrap_or(false),
        &services,
        &market,
    )
    .await
}

/// Scope-agnostic import: any source into a project root or a workspace.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn import_skill(
    target: SkillImportTarget,
    source: ProjectSkillImportSource,
    name: Option<String>,
    overwrite: Option<bool>,
    service: State<'_, Arc<ProjectSkillService>>,
    workspace_service: State<'_, Arc<WorkspaceSkillService>>,
    market: State<'_, Arc<SkillMarketService>>,
    external: State<'_, Arc<ExternalSkillRegistry>>,
    app_paths: State<'_, Arc<AppPaths>>,
) -> AppResult<ProjectSkill> {
    debug!(target = ?target, source = ?source, "cmd::import_skill");
    let services = SkillServices {
        project: &service,
        workspace: &workspace_service,
        external: &external,
        app_paths: &app_paths,
    };
    let resolved = resolve_source(source, &services)?;
    import_into(
        target,
        resolved,
        name,
        overwrite.unwrap_or(false),
        &services,
        &market,
    )
    .await
}

fn refuse_existing(target: &Path, name: &str, overwrite: bool) -> AppResult<()> {
    if target.exists() && !overwrite {
        return Err(AppError::from(format!("Skill '{}' already exists", name)));
    }
    Ok(())
}

fn leaf_name(dir: &Path) -> String {
    dir.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

/// External discovery records the SKILL.md path; the importable unit is its folder.
fn skill_dir_of(skill_md: &Path) -> AppResult<PathBuf> {
    let dir = skill_md
        .parent()
        .ok_or_else(|| AppError::from("External skill path has no parent folder"))?;
    if !dir.join("SKILL.md").is_file() {
        return Err(AppError::from(format!(
            "{} is not a skill folder (no SKILL.md)",
            dir.display()
        )));
    }
    Ok(dir.to_path_buf())
}
