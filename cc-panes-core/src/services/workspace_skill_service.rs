//! Workspace-level Agent Skills: the tier between "checked into one repo" and "installed
//! for the whole machine".
//!
//! CLIs have no notion of a workspace, so these can never be discovered natively. Instead
//! the workspace owns a plugin-shaped folder (`<workspace>/skills`, see
//! `AppPaths::workspace_skills_root`) that is mounted **per session** exactly like the
//! bundled skills: Claude `--plugin-dir`, Codex `-c skills.config`. CLIs that cannot mount
//! a folder get the skills inlined into the session prompt. Nothing is written to any
//! project or to the user's CLI home.
//!
//! On-disk layout (a valid Claude plugin):
//! ```text
//! <workspace>/skills/
//!   .claude-plugin/plugin.json
//!   skills/<name>/SKILL.md (+ scripts/, references/ …)
//! ```

use crate::services::project_skill_service::{
    copy_dir_filtered, describe_skill_folder, has_frontmatter, list_files_relative, safe_rel_dir,
    scaffold_skill_md, validate_skill_name, walk_for_skills, ProjectSkill, ProjectSkillContent,
    PROJECT_SKILL_FILE,
};
use crate::utils::atomic_file;
use crate::utils::error::{AppError, AppResult};
use crate::utils::AppPaths;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::debug;

/// Logical root label used in `ProjectSkill.root` / ids for workspace skills.
pub const WORKSPACE_SKILL_ROOT: &str = "workspace";
/// CLIs that receive the workspace plugin folder as a native mount.
pub const WORKSPACE_SKILL_NATIVE_CONSUMERS: &[&str] = &["claude", "codex"];
const PLUGIN_DIR: &str = ".claude-plugin";
const PLUGIN_MANIFEST: &str = "plugin.json";
const SKILLS_SUBDIR: &str = "skills";

pub struct WorkspaceSkillService {
    app_paths: Arc<AppPaths>,
}

impl WorkspaceSkillService {
    pub fn new(app_paths: Arc<AppPaths>) -> Self {
        Self { app_paths }
    }

    /// Plugin root to pass to `--plugin-dir` / `skills.config`. `None` when the workspace has
    /// no skills yet, so callers never mount an empty (and manifest-less) folder.
    pub fn mount_root(&self, workspace_name: &str) -> Option<PathBuf> {
        let name = workspace_name.trim();
        if name.is_empty() {
            return None;
        }
        let root = self.app_paths.workspace_skills_root(name);
        let has_skill = self
            .list(name)
            .map(|skills| !skills.is_empty())
            .unwrap_or(false);
        if has_skill && root.join(PLUGIN_DIR).join(PLUGIN_MANIFEST).is_file() {
            Some(root)
        } else {
            None
        }
    }

    pub fn list(&self, workspace_name: &str) -> AppResult<Vec<ProjectSkill>> {
        let skills_dir = self.skills_dir(workspace_name)?;
        if !skills_dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut found = Vec::new();
        walk_for_skills(&skills_dir, &skills_dir, 0, &mut found)?;
        let mut skills: Vec<ProjectSkill> = found
            .iter()
            .filter_map(|dir| {
                describe_skill_folder(WORKSPACE_SKILL_ROOT, &skills_dir, dir, consumers())
            })
            .collect();
        skills.sort_by_key(|skill| skill.name.to_lowercase());
        debug!(workspace = %workspace_name, count = skills.len(), "svc::list_workspace_skills");
        Ok(skills)
    }

    pub fn read(
        &self,
        workspace_name: &str,
        rel_dir: &str,
    ) -> AppResult<Option<ProjectSkillContent>> {
        let skills_dir = self.skills_dir(workspace_name)?;
        let dir = skills_dir.join(safe_rel_dir(rel_dir)?);
        let skill_md = dir.join(PROJECT_SKILL_FILE);
        if !skill_md.is_file() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&skill_md)
            .map_err(|e| AppError::from(format!("Failed to read SKILL.md: {}", e)))?;
        let skill = describe_skill_folder(WORKSPACE_SKILL_ROOT, &skills_dir, &dir, consumers())
            .ok_or_else(|| AppError::from("Skill folder could not be described"))?;
        Ok(Some(ProjectSkillContent {
            skill,
            content,
            files: list_files_relative(&dir),
        }))
    }

    /// Read every skill's SKILL.md — used to inline workspace skills into a session prompt for
    /// CLIs that cannot mount the plugin folder.
    pub fn read_all(&self, workspace_name: &str) -> AppResult<Vec<ProjectSkillContent>> {
        let mut out = Vec::new();
        for skill in self.list(workspace_name)? {
            if let Some(content) = self.read(workspace_name, &skill.rel_dir)? {
                out.push(content);
            }
        }
        Ok(out)
    }

    pub fn save(&self, workspace_name: &str, name: &str, content: &str) -> AppResult<ProjectSkill> {
        let name = validate_skill_name(name)?;
        let skills_dir = self.skills_dir(workspace_name)?;
        let dir = skills_dir.join(name);
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::from(format!("Failed to create skill folder: {}", e)))?;
        let body = if content.trim().is_empty() || !has_frontmatter(content) {
            scaffold_skill_md(name, content)
        } else {
            content.to_string()
        };
        std::fs::write(dir.join(PROJECT_SKILL_FILE), body)
            .map_err(|e| AppError::from(format!("Failed to write SKILL.md: {}", e)))?;
        self.ensure_manifest(workspace_name)?;
        describe_skill_folder(WORKSPACE_SKILL_ROOT, &skills_dir, &dir, consumers())
            .ok_or_else(|| AppError::from("Skill folder could not be described after save"))
    }

    pub fn delete(&self, workspace_name: &str, rel_dir: &str) -> AppResult<bool> {
        let dir = self
            .skills_dir(workspace_name)?
            .join(safe_rel_dir(rel_dir)?);
        if !dir.join(PROJECT_SKILL_FILE).is_file() {
            return Ok(false);
        }
        std::fs::remove_dir_all(&dir)
            .map_err(|e| AppError::from(format!("Failed to delete skill folder: {}", e)))?;
        Ok(true)
    }

    /// Copy a skill folder (project skill, user skill, external CLI skill…) into the workspace.
    pub fn import_dir(
        &self,
        workspace_name: &str,
        name: &str,
        source_dir: &Path,
        overwrite: bool,
    ) -> AppResult<ProjectSkill> {
        let name = validate_skill_name(name)?;
        if !source_dir.join(PROJECT_SKILL_FILE).is_file() {
            return Err(AppError::from(format!(
                "{} has no SKILL.md",
                source_dir.display()
            )));
        }
        let skills_dir = self.skills_dir(workspace_name)?;
        let target = skills_dir.join(name);
        if target.exists() {
            if !overwrite {
                return Err(AppError::from(format!(
                    "Skill '{}' already exists in workspace {}",
                    name, workspace_name
                )));
            }
            std::fs::remove_dir_all(&target)
                .map_err(|e| AppError::from(format!("Failed to replace skill folder: {}", e)))?;
        }
        copy_dir_filtered(source_dir, &target)?;
        self.ensure_manifest(workspace_name)?;
        describe_skill_folder(WORKSPACE_SKILL_ROOT, &skills_dir, &target, consumers())
            .ok_or_else(|| AppError::from("Imported skill folder could not be described"))
    }

    /// Target folder for installers that write files themselves (market downloads). The
    /// caller must call `finalize_external_write` afterwards so the plugin manifest exists.
    pub fn target_dir(&self, workspace_name: &str, name: &str) -> AppResult<PathBuf> {
        let name = validate_skill_name(name)?;
        Ok(self.skills_dir(workspace_name)?.join(name))
    }

    pub fn finalize_external_write(&self, workspace_name: &str) -> AppResult<()> {
        self.ensure_manifest(workspace_name)
    }

    pub fn describe(&self, workspace_name: &str, name: &str) -> AppResult<ProjectSkill> {
        let skills_dir = self.skills_dir(workspace_name)?;
        let dir = skills_dir.join(safe_rel_dir(name)?);
        describe_skill_folder(WORKSPACE_SKILL_ROOT, &skills_dir, &dir, consumers()).ok_or_else(
            || {
                AppError::from(format!(
                    "Skill '{}' not found in workspace {}",
                    name, workspace_name
                ))
            },
        )
    }

    fn skills_dir(&self, workspace_name: &str) -> AppResult<PathBuf> {
        let name = workspace_name.trim();
        if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
            return Err(AppError::from(format!(
                "Invalid workspace name '{}'",
                workspace_name
            )));
        }
        Ok(self
            .app_paths
            .workspace_skills_root(name)
            .join(SKILLS_SUBDIR))
    }

    fn ensure_manifest(&self, workspace_name: &str) -> AppResult<()> {
        let root = self.app_paths.workspace_skills_root(workspace_name.trim());
        let path = root.join(PLUGIN_DIR).join(PLUGIN_MANIFEST);
        if path.is_file() {
            return Ok(());
        }
        let manifest = serde_json::json!({
            "name": format!("ccpanes-workspace-{}", slug(workspace_name)),
            "version": "1.0.0",
            "description": format!("CC-Panes workspace skills for '{}'", workspace_name.trim()),
            "author": { "name": "CC-Panes" },
        });
        let payload = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| AppError::from(format!("Failed to serialize plugin manifest: {}", e)))?;
        atomic_file::write_atomic(&path, &payload)
            .map_err(|e| AppError::from(format!("Failed to write {}: {}", path.display(), e)))?;
        Ok(())
    }
}

fn consumers() -> Vec<String> {
    WORKSPACE_SKILL_NATIVE_CONSUMERS
        .iter()
        .map(|id| id.to_string())
        .collect()
}

fn slug(value: &str) -> String {
    let mut out: String = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "workspace".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn service() -> (TempDir, WorkspaceSkillService) {
        let tmp = TempDir::new().unwrap();
        let paths = AppPaths::new(Some(tmp.path().to_string_lossy().to_string()));
        (tmp, WorkspaceSkillService::new(Arc::new(paths)))
    }

    #[test]
    fn empty_workspace_has_no_mount_root_and_lists_nothing() {
        let (_tmp, svc) = service();
        assert!(svc.list("alpha").unwrap().is_empty());
        assert!(svc.mount_root("alpha").is_none());
        assert!(svc.mount_root("  ").is_none());
    }

    #[test]
    fn save_creates_plugin_layout_and_mount_root_appears() {
        let (tmp, svc) = service();
        let saved = svc.save("alpha", "review", "").unwrap();
        assert_eq!(saved.root, WORKSPACE_SKILL_ROOT);
        assert_eq!(saved.id, "workspace::review");
        assert_eq!(saved.consumers, vec!["claude", "codex"]);

        let root = tmp.path().join("workspaces").join("alpha").join("skills");
        assert!(root.join(".claude-plugin").join("plugin.json").is_file());
        assert!(root
            .join("skills")
            .join("review")
            .join("SKILL.md")
            .is_file());
        assert_eq!(svc.mount_root("alpha"), Some(root));

        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                tmp.path()
                    .join("workspaces/alpha/skills/.claude-plugin/plugin.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], "ccpanes-workspace-alpha");
    }

    #[test]
    fn read_all_delete_and_import_roundtrip() {
        let (_tmp, svc) = service();
        svc.save("alpha", "a", "---\nname: a\ndescription: A\n---\nDo A")
            .unwrap();
        svc.save("alpha", "b", "Do B").unwrap();
        let all = svc.read_all("alpha").unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].skill.description.as_deref(), Some("A"));

        let source = TempDir::new().unwrap();
        let src = source.path().join("pdf");
        std::fs::create_dir_all(src.join("scripts")).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: pdf\n---\n").unwrap();
        std::fs::write(src.join("scripts/x.py"), "").unwrap();
        std::fs::write(src.join("skill.json"), "{}").unwrap();
        let imported = svc.import_dir("alpha", "pdf", &src, false).unwrap();
        assert!(imported.has_scripts);
        assert_eq!(imported.file_count, 2);
        assert!(svc.import_dir("alpha", "pdf", &src, false).is_err());

        assert!(svc.delete("alpha", "a").unwrap());
        assert!(!svc.delete("alpha", "a").unwrap());
        assert_eq!(svc.list("alpha").unwrap().len(), 2);
        assert!(svc.delete("alpha", "../../x").is_err());
    }

    #[test]
    fn rejects_bad_workspace_names() {
        let (_tmp, svc) = service();
        assert!(svc.list("../etc").is_err());
        assert!(svc.list("a/b").is_err());
        assert!(svc.save("", "x", "").is_err());
    }

    #[test]
    fn slug_is_manifest_safe() {
        assert_eq!(slug("My Space 2"), "my-space-2");
        assert_eq!(slug("默认工作空间"), "workspace");
        assert_eq!(slug("--a--"), "a");
    }
}
