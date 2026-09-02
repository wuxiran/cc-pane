//! Project-level Agent Skills (`<root>/<name>/SKILL.md` folders checked into the repo).
//!
//! Each CLI scans its own project root, so the same skill is visible to different agents
//! depending on which folder it lives in. This service enumerates the well-known roots,
//! tells the UI which CLIs consume each one, and does the folder-level CRUD (create /
//! edit SKILL.md / delete / move between roots / copy a skill folder in). It never touches
//! the legacy `.claude/commands/*.md` slash commands — those stay with `SkillService`.

use crate::services::external_skill_registry::parse_skill_metadata;
use crate::utils::error::{AppError, AppResult};
use crate::utils::error_codes as EC;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tracing::debug;

pub const PROJECT_SKILL_FILE: &str = "SKILL.md";
const MAX_SCAN_DEPTH: usize = 3;
const MAX_NAME_LEN: usize = 64;

/// A folder the CLIs look in for project skills, and which CLIs read it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillRoot {
    /// Relative to the project, forward slashes: `.claude/skills`
    pub root: &'static str,
    /// CLI ids that natively scan this root.
    pub consumers: &'static [&'static str],
    /// Vendor-neutral root recommended when the user has no preference.
    pub recommended: bool,
}

/// Order = display order. `.agents/skills` first because it is the cross-vendor
/// location (Codex + Cursor) per agentskills.io; Claude Code still needs `.claude/skills`.
pub const PROJECT_SKILL_ROOTS: &[ProjectSkillRoot] = &[
    ProjectSkillRoot {
        root: ".agents/skills",
        consumers: &["codex", "cursor"],
        recommended: true,
    },
    ProjectSkillRoot {
        root: ".claude/skills",
        consumers: &["claude", "cursor"],
        recommended: true,
    },
    ProjectSkillRoot {
        root: ".cursor/skills",
        consumers: &["cursor"],
        recommended: false,
    },
    ProjectSkillRoot {
        root: ".codex/skills",
        consumers: &["cursor"],
        recommended: false,
    },
    ProjectSkillRoot {
        root: ".gemini/skills",
        consumers: &["gemini"],
        recommended: false,
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkill {
    /// `<root>::<relDir>` — stable across renames of description, unique per project.
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub root: String,
    /// Folder path relative to `root` (usually just the name; may be `team/name`).
    pub rel_dir: String,
    pub dir_path: String,
    pub skill_md_path: String,
    pub file_count: usize,
    pub has_scripts: bool,
    pub consumers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillContent {
    pub skill: ProjectSkill,
    pub content: String,
    /// Files inside the skill folder relative to it (SKILL.md first).
    pub files: Vec<String>,
}

#[derive(Default)]
pub struct ProjectSkillService;

impl ProjectSkillService {
    pub fn new() -> Self {
        Self
    }

    pub fn roots() -> &'static [ProjectSkillRoot] {
        PROJECT_SKILL_ROOTS
    }

    pub fn list(&self, project_path: &str) -> AppResult<Vec<ProjectSkill>> {
        debug!(project = %project_path, "svc::list_project_skills");
        let project = Path::new(project_path);
        let mut skills = Vec::new();
        for root in PROJECT_SKILL_ROOTS {
            let root_dir = project.join(root.root.replace('/', std::path::MAIN_SEPARATOR_STR));
            if !root_dir.is_dir() {
                continue;
            }
            let mut found = Vec::new();
            walk_for_skills(&root_dir, &root_dir, 0, &mut found)?;
            for dir in found {
                if let Some(skill) = describe_skill_dir(root, &root_dir, &dir) {
                    skills.push(skill);
                }
            }
        }
        skills.sort_by(|left, right| {
            root_index(&left.root)
                .cmp(&root_index(&right.root))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(skills)
    }

    pub fn read(
        &self,
        project_path: &str,
        root: &str,
        rel_dir: &str,
    ) -> AppResult<Option<ProjectSkillContent>> {
        let root_def = require_root(root)?;
        let root_dir = root_dir_for(project_path, root_def);
        let dir = root_dir.join(safe_rel_dir(rel_dir)?);
        let skill_md = dir.join(PROJECT_SKILL_FILE);
        if !skill_md.is_file() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&skill_md)
            .map_err(|e| AppError::from(format!("Failed to read SKILL.md: {}", e)))?;
        let skill = describe_skill_dir(root_def, &root_dir, &dir)
            .ok_or_else(|| AppError::from("Skill folder could not be described"))?;
        Ok(Some(ProjectSkillContent {
            skill,
            content,
            files: list_files_relative(&dir),
        }))
    }

    /// Create or overwrite `SKILL.md`. New skills get a frontmatter scaffold when the
    /// content has none, so the CLIs can index them immediately.
    pub fn save(
        &self,
        project_path: &str,
        root: &str,
        name: &str,
        content: &str,
    ) -> AppResult<ProjectSkill> {
        let root_def = require_root(root)?;
        let name = validate_skill_name(name)?;
        let root_dir = root_dir_for(project_path, root_def);
        let dir = root_dir.join(name);
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::from(format!("Failed to create skill folder: {}", e)))?;
        let body = if content.trim().is_empty() || !has_frontmatter(content) {
            scaffold_skill_md(name, content)
        } else {
            content.to_string()
        };
        std::fs::write(dir.join(PROJECT_SKILL_FILE), body)
            .map_err(|e| AppError::from(format!("Failed to write SKILL.md: {}", e)))?;
        describe_skill_dir(root_def, &root_dir, &dir)
            .ok_or_else(|| AppError::from("Skill folder could not be described after save"))
    }

    pub fn delete(&self, project_path: &str, root: &str, rel_dir: &str) -> AppResult<bool> {
        let root_def = require_root(root)?;
        let dir = root_dir_for(project_path, root_def).join(safe_rel_dir(rel_dir)?);
        if !dir.join(PROJECT_SKILL_FILE).is_file() {
            return Ok(false);
        }
        std::fs::remove_dir_all(&dir)
            .map_err(|e| AppError::from(format!("Failed to delete skill folder: {}", e)))?;
        Ok(true)
    }

    /// Move a skill folder to another root (e.g. `.claude/skills` → `.agents/skills` to
    /// expose it to Codex/Cursor). Refuses to overwrite an existing target.
    pub fn move_to_root(
        &self,
        project_path: &str,
        root: &str,
        rel_dir: &str,
        to_root: &str,
    ) -> AppResult<ProjectSkill> {
        let from_def = require_root(root)?;
        let to_def = require_root(to_root)?;
        let rel = safe_rel_dir(rel_dir)?;
        let source = root_dir_for(project_path, from_def).join(&rel);
        if !source.join(PROJECT_SKILL_FILE).is_file() {
            return Err(AppError::from(format!(
                "Skill '{}' not found in {}",
                rel_dir, root
            )));
        }
        let target_root = root_dir_for(project_path, to_def);
        // Flatten to the leaf name at the destination; category folders are source-specific.
        let leaf = rel
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| AppError::from("Invalid skill folder name"))?;
        let target = target_root.join(leaf);
        if target.exists() {
            return Err(AppError::from(format!(
                "Skill '{}' already exists in {}",
                leaf, to_root
            )));
        }
        std::fs::create_dir_all(&target_root)
            .map_err(|e| AppError::from(format!("Failed to create target root: {}", e)))?;
        std::fs::rename(&source, &target)
            .map_err(|e| AppError::from(format!("Failed to move skill folder: {}", e)))?;
        describe_skill_dir(to_def, &target_root, &target)
            .ok_or_else(|| AppError::from("Moved skill folder could not be described"))
    }

    /// Copy an existing skill folder (user skill, external CLI skill, another project's
    /// skill) into this project. `skill.json` is CC-Panes metadata and is not copied.
    pub fn import_dir(
        &self,
        project_path: &str,
        root: &str,
        name: &str,
        source_dir: &Path,
        overwrite: bool,
    ) -> AppResult<ProjectSkill> {
        let root_def = require_root(root)?;
        let name = validate_skill_name(name)?;
        if !source_dir.join(PROJECT_SKILL_FILE).is_file() {
            return Err(AppError::from(format!(
                "{} has no SKILL.md",
                source_dir.display()
            )));
        }
        let root_dir = root_dir_for(project_path, root_def);
        let target = root_dir.join(name);
        if target.exists() {
            if !overwrite {
                return Err(AppError::from(format!(
                    "Skill '{}' already exists in {}",
                    name, root
                )));
            }
            std::fs::remove_dir_all(&target)
                .map_err(|e| AppError::from(format!("Failed to replace skill folder: {}", e)))?;
        }
        copy_dir_filtered(source_dir, &target)?;
        describe_skill_dir(root_def, &root_dir, &target)
            .ok_or_else(|| AppError::from("Imported skill folder could not be described"))
    }

    /// Target folder for installers that write files themselves (market downloads).
    pub fn target_dir(&self, project_path: &str, root: &str, name: &str) -> AppResult<PathBuf> {
        let root_def = require_root(root)?;
        let name = validate_skill_name(name)?;
        Ok(root_dir_for(project_path, root_def).join(name))
    }

    pub fn describe(&self, project_path: &str, root: &str, name: &str) -> AppResult<ProjectSkill> {
        let root_def = require_root(root)?;
        let root_dir = root_dir_for(project_path, root_def);
        let dir = root_dir.join(safe_rel_dir(name)?);
        describe_skill_dir(root_def, &root_dir, &dir)
            .ok_or_else(|| AppError::from(format!("Skill '{}' not found in {}", name, root)))
    }
}

fn root_index(root: &str) -> usize {
    PROJECT_SKILL_ROOTS
        .iter()
        .position(|def| def.root == root)
        .unwrap_or(usize::MAX)
}

fn require_root(root: &str) -> AppResult<&'static ProjectSkillRoot> {
    let normalized = root.trim().trim_matches('/').replace('\\', "/");
    PROJECT_SKILL_ROOTS
        .iter()
        .find(|def| def.root == normalized)
        .ok_or_else(|| AppError::from(format!("Unknown project skill root '{}'", root)))
}

fn root_dir_for(project_path: &str, root: &ProjectSkillRoot) -> PathBuf {
    Path::new(project_path).join(root.root.replace('/', std::path::MAIN_SEPARATOR_STR))
}

/// Skill folder names double as the skill id for most CLIs: lowercase kebab-ish only.
pub fn validate_skill_name(name: &str) -> AppResult<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::coded(
            EC::SKILL_NAME_EMPTY,
            "Skill name cannot be empty",
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(AppError::coded(
            EC::SKILL_NAME_PATH_SEPARATOR,
            "Skill name cannot contain path separators",
        ));
    }
    if trimmed.starts_with('.') {
        return Err(AppError::coded(
            EC::SKILL_NAME_DOT_PREFIX,
            "Skill name cannot start with '.'",
        ));
    }
    if trimmed.len() > MAX_NAME_LEN
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_'))
    {
        return Err(AppError::from(
            "Skill name must be lowercase letters, digits, '-' or '_' (max 64 chars)",
        ));
    }
    Ok(trimmed)
}

pub(crate) fn safe_rel_dir(rel_dir: &str) -> AppResult<PathBuf> {
    let normalized = rel_dir.trim().trim_matches('/').replace('\\', "/");
    if normalized.is_empty() {
        return Err(AppError::from("Skill folder cannot be empty"));
    }
    let mut out = PathBuf::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.ends_with(':') {
            return Err(AppError::from(format!(
                "Invalid skill folder '{}'",
                rel_dir
            )));
        }
        out.push(segment);
    }
    Ok(out)
}

pub(crate) fn walk_for_skills(
    root_dir: &Path,
    dir: &Path,
    depth: usize,
    found: &mut Vec<PathBuf>,
) -> AppResult<()> {
    if dir.join(PROJECT_SKILL_FILE).is_file() && dir != root_dir {
        found.push(dir.to_path_buf());
        // A SKILL.md shadows anything nested below it (same rule as the skills CLI).
        return Ok(());
    }
    if depth >= MAX_SCAN_DEPTH {
        return Ok(());
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    let mut children: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with('.'))
        })
        .collect();
    children.sort();
    for child in children {
        walk_for_skills(root_dir, &child, depth + 1, found)?;
    }
    Ok(())
}

fn describe_skill_dir(
    root: &ProjectSkillRoot,
    root_dir: &Path,
    dir: &Path,
) -> Option<ProjectSkill> {
    describe_skill_folder(
        root.root,
        root_dir,
        dir,
        root.consumers.iter().map(|id| id.to_string()).collect(),
    )
}

/// Describe any `<root_dir>/<rel>/SKILL.md` folder under a logical root label. Shared with
/// the workspace skill store, which has a single root but the same on-disk shape.
pub(crate) fn describe_skill_folder(
    root_label: &str,
    root_dir: &Path,
    dir: &Path,
    consumers: Vec<String>,
) -> Option<ProjectSkill> {
    let skill_md = dir.join(PROJECT_SKILL_FILE);
    let content = std::fs::read_to_string(&skill_md).ok()?;
    let rel_dir = dir
        .strip_prefix(root_dir)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let leaf = dir.file_name()?.to_str()?;
    let (name, description) = parse_skill_metadata(&content, leaf);
    let files = list_files_relative(dir);
    let has_scripts = files
        .iter()
        .any(|file| file.starts_with("scripts/") || file.ends_with(".py") || file.ends_with(".sh"));
    Some(ProjectSkill {
        id: format!("{}::{}", root_label, rel_dir),
        name,
        description,
        root: root_label.to_string(),
        rel_dir,
        dir_path: dir.to_string_lossy().to_string(),
        skill_md_path: skill_md.to_string_lossy().to_string(),
        file_count: files.len(),
        has_scripts,
        consumers,
    })
}

pub(crate) fn list_files_relative(dir: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect_files(dir, dir, &mut files);
    files.sort_by(|left, right| {
        (left != PROJECT_SKILL_FILE)
            .cmp(&(right != PROJECT_SKILL_FILE))
            .then_with(|| left.cmp(right))
    });
    files
}

fn collect_files(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if path.is_dir() {
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == ".git")
            {
                continue;
            }
            collect_files(base, &path, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

pub(crate) fn copy_dir_filtered(source: &Path, target: &Path) -> AppResult<()> {
    std::fs::create_dir_all(target)
        .map_err(|e| AppError::from(format!("Failed to create skill folder: {}", e)))?;
    for entry in std::fs::read_dir(source)
        .map_err(|e| AppError::from(format!("Failed to read source skill folder: {}", e)))?
    {
        let entry = entry.map_err(|e| AppError::from(format!("Failed to read entry: {}", e)))?;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git" || name_str == "skill.json" {
            continue;
        }
        let dest = target.join(&name);
        if path.is_dir() {
            copy_dir_filtered(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest)
                .map_err(|e| AppError::from(format!("Failed to copy {}: {}", name_str, e)))?;
        }
    }
    Ok(())
}

pub(crate) fn has_frontmatter(content: &str) -> bool {
    content
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("---")
}

pub(crate) fn scaffold_skill_md(name: &str, body: &str) -> String {
    let body = body.trim();
    let mut out = format!(
        "---\nname: {name}\ndescription: Describe when this skill should be used.\n---\n\n"
    );
    if body.is_empty() {
        out.push_str(&format!(
            "# {name}\n\nInstructions for the agent go here.\n"
        ));
    } else {
        out.push_str(body);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn project() -> (TempDir, String) {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        (tmp, path)
    }

    fn write_skill(project: &str, root: &str, rel: &str, content: &str) {
        let dir = Path::new(project).join(root).join(rel);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), content).unwrap();
    }

    #[test]
    fn roots_are_unique_and_include_the_two_recommended_ones() {
        let mut seen = std::collections::HashSet::new();
        for root in PROJECT_SKILL_ROOTS {
            assert!(seen.insert(root.root));
            assert!(!root.consumers.is_empty());
        }
        let recommended: Vec<_> = PROJECT_SKILL_ROOTS
            .iter()
            .filter(|r| r.recommended)
            .map(|r| r.root)
            .collect();
        assert_eq!(recommended, vec![".agents/skills", ".claude/skills"]);
    }

    #[test]
    fn list_scans_all_roots_nested_dirs_and_reports_consumers() {
        let (_tmp, project) = project();
        write_skill(
            &project,
            ".claude/skills",
            "pdf",
            "---\nname: pdf\ndescription: Read PDFs\n---\nbody",
        );
        write_skill(
            &project,
            ".agents/skills",
            "team/deploy",
            "# deploy\nShip it",
        );
        std::fs::create_dir_all(Path::new(&project).join(".agents/skills/team/deploy/scripts"))
            .unwrap();
        std::fs::write(
            Path::new(&project).join(".agents/skills/team/deploy/scripts/run.sh"),
            "x",
        )
        .unwrap();
        // 没有 SKILL.md 的目录不算；隐藏目录跳过
        std::fs::create_dir_all(Path::new(&project).join(".cursor/skills/.hidden")).unwrap();
        std::fs::write(
            Path::new(&project).join(".cursor/skills/.hidden/SKILL.md"),
            "x",
        )
        .unwrap();
        std::fs::create_dir_all(Path::new(&project).join(".cursor/skills/empty")).unwrap();

        let skills = ProjectSkillService::new().list(&project).unwrap();
        let ids: Vec<_> = skills.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![".agents/skills::team/deploy", ".claude/skills::pdf"]
        );

        let deploy = &skills[0];
        assert_eq!(deploy.name, "deploy");
        assert_eq!(deploy.description.as_deref(), Some("deploy"));
        assert!(deploy.has_scripts);
        assert_eq!(deploy.file_count, 2);
        assert_eq!(deploy.consumers, vec!["codex", "cursor"]);

        let pdf = &skills[1];
        assert_eq!(pdf.description.as_deref(), Some("Read PDFs"));
        assert_eq!(pdf.consumers, vec!["claude", "cursor"]);
        assert_eq!(pdf.rel_dir, "pdf");
    }

    #[test]
    fn save_scaffolds_frontmatter_for_new_skills_and_keeps_existing() {
        let (_tmp, project) = project();
        let svc = ProjectSkillService::new();
        let created = svc.save(&project, ".claude/skills", "review", "").unwrap();
        assert_eq!(created.name, "review");
        let content = svc
            .read(&project, ".claude/skills", "review")
            .unwrap()
            .unwrap();
        assert!(content.content.starts_with("---\nname: review\n"));
        assert_eq!(content.files, vec!["SKILL.md"]);

        let custom = "---\nname: review\ndescription: Custom\n---\nDo it";
        svc.save(&project, ".claude/skills", "review", custom)
            .unwrap();
        let again = svc
            .read(&project, ".claude/skills", "review")
            .unwrap()
            .unwrap();
        assert_eq!(again.content, custom);
        assert_eq!(again.skill.description.as_deref(), Some("Custom"));

        // 无 frontmatter 的正文会被包一层 scaffold，但正文保留
        svc.save(&project, ".claude/skills", "plain", "Just do X")
            .unwrap();
        let plain = svc
            .read(&project, ".claude/skills", "plain")
            .unwrap()
            .unwrap();
        assert!(plain.content.contains("Just do X"));
        assert!(plain.content.starts_with("---"));
    }

    #[test]
    fn save_rejects_bad_names_and_unknown_roots() {
        let (_tmp, project) = project();
        let svc = ProjectSkillService::new();
        assert!(svc.save(&project, ".claude/skills", "", "x").is_err());
        assert!(svc
            .save(&project, ".claude/skills", "../evil", "x")
            .is_err());
        assert!(svc
            .save(&project, ".claude/skills", ".hidden", "x")
            .is_err());
        assert!(svc
            .save(&project, ".claude/skills", "Has Space", "x")
            .is_err());
        assert!(svc.save(&project, ".claude/skills", "UPPER", "x").is_err());
        assert!(svc.save(&project, "node_modules", "ok", "x").is_err());
        assert!(svc
            .save(&project, ".agents/skills", "ok-name_1", "x")
            .is_ok());
    }

    #[test]
    fn delete_and_move_between_roots() {
        let (_tmp, project) = project();
        let svc = ProjectSkillService::new();
        write_skill(&project, ".claude/skills", "pdf", "# pdf");
        std::fs::write(Path::new(&project).join(".claude/skills/pdf/notes.md"), "n").unwrap();

        let moved = svc
            .move_to_root(&project, ".claude/skills", "pdf", ".agents/skills")
            .unwrap();
        assert_eq!(moved.root, ".agents/skills");
        assert_eq!(moved.file_count, 2);
        assert!(!Path::new(&project).join(".claude/skills/pdf").exists());
        assert!(Path::new(&project)
            .join(".agents/skills/pdf/notes.md")
            .is_file());

        // 目标已存在拒绝覆盖
        write_skill(&project, ".claude/skills", "pdf", "# other");
        assert!(svc
            .move_to_root(&project, ".claude/skills", "pdf", ".agents/skills")
            .is_err());

        assert!(svc.delete(&project, ".agents/skills", "pdf").unwrap());
        assert!(!svc.delete(&project, ".agents/skills", "pdf").unwrap());
        assert!(svc.delete(&project, ".agents/skills", "../../etc").is_err());
    }

    #[test]
    fn import_dir_copies_everything_except_ccpanes_metadata() {
        let (_tmp, project) = project();
        let source_tmp = TempDir::new().unwrap();
        let source = source_tmp.path().join("obsidian");
        std::fs::create_dir_all(source.join("references")).unwrap();
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: obsidian\ndescription: Notes\n---\n",
        )
        .unwrap();
        std::fs::write(source.join("references/A.md"), "a").unwrap();
        std::fs::write(source.join("skill.json"), "{}").unwrap();

        let svc = ProjectSkillService::new();
        let imported = svc
            .import_dir(&project, ".agents/skills", "obsidian", &source, false)
            .unwrap();
        assert_eq!(imported.description.as_deref(), Some("Notes"));
        assert_eq!(imported.file_count, 2);
        assert!(!Path::new(&project)
            .join(".agents/skills/obsidian/skill.json")
            .exists());

        assert!(svc
            .import_dir(&project, ".agents/skills", "obsidian", &source, false)
            .is_err());
        assert!(svc
            .import_dir(&project, ".agents/skills", "obsidian", &source, true)
            .is_ok());

        let no_skill = source_tmp.path().join("nope");
        std::fs::create_dir_all(&no_skill).unwrap();
        assert!(svc
            .import_dir(&project, ".agents/skills", "nope", &no_skill, false)
            .is_err());
    }
}
