//! Project-level Agent Skills (`<root>/<name>/SKILL.md` folders) — list / edit / move /
//! import. Slash commands (`.claude/commands/*.md`) stay in `skill_commands.rs`.

use crate::services::{SkillMarketEntry, SkillMarketService};
use crate::utils::{validate_path, AppError, AppResult};
use cc_panes_core::services::{
    ExternalSkillRegistry, ProjectSkill, ProjectSkillContent, ProjectSkillRoot,
    ProjectSkillService, UserSkillService,
};
use cc_panes_core::utils::AppPaths;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

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
    /// Download straight from the skill market into the project.
    Market { entry: Box<SkillMarketEntry> },
}

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
    market: State<'_, Arc<SkillMarketService>>,
    external: State<'_, Arc<ExternalSkillRegistry>>,
    app_paths: State<'_, Arc<AppPaths>>,
) -> AppResult<ProjectSkill> {
    debug!(project_path = %project_path, root = %root, source = ?source, "cmd::import_project_skill");
    validate_path(&project_path)?;
    let overwrite = overwrite.unwrap_or(false);
    match source {
        ProjectSkillImportSource::User { id } => {
            let user_root = app_paths.user_skills_dir();
            let source_dir = UserSkillService::skill_dir_for(&user_root, &id)?;
            let name = name.unwrap_or(id);
            service.import_dir(&project_path, &root, &name, &source_dir, overwrite)
        }
        ProjectSkillImportSource::External { id } => {
            let skill = external
                .get(&id)?
                .ok_or_else(|| AppError::from(format!("External skill '{}' not found", id)))?;
            let source_dir = skill_dir_of(&skill.path)?;
            let fallback = source_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
            let name = name.unwrap_or(fallback);
            service.import_dir(&project_path, &root, &name, &source_dir, overwrite)
        }
        ProjectSkillImportSource::Project {
            project_path: from_project,
            root: from_root,
            rel_dir,
        } => {
            validate_path(&from_project)?;
            let source = service.describe(&from_project, &from_root, &rel_dir)?;
            let source_dir = PathBuf::from(&source.dir_path);
            let leaf = rel_dir
                .trim_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string();
            let name = name.unwrap_or(leaf);
            service.import_dir(&project_path, &root, &name, &source_dir, overwrite)
        }
        ProjectSkillImportSource::Market { entry } => {
            let name = name.unwrap_or_else(|| entry.repo_skill_leaf());
            let target = service.target_dir(&project_path, &root, &name)?;
            if target.exists() && !overwrite {
                return Err(AppError::from(format!(
                    "Skill '{}' already exists in {}",
                    name, root
                )));
            }
            market.install_entry_to_dir(&entry, &target).await?;
            service.describe(&project_path, &root, &name)
        }
    }
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
