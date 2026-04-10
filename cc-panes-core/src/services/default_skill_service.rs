//! 默认 Skill 全局发布服务
//!
//! 应用启动时将内置模板同时发布到：
//! - Claude 命令目录（如 `~/.claude/commands/ccpanes/`）
//! - Codex 技能目录（如 `~/.codex/skills/ccpanes-launch-task/SKILL.md`）

use cc_cli_adapters::CliToolRegistry;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

pub(crate) const BUNDLED_NAMESPACE: &str = "ccpanes";
pub(crate) const VERSION_FILE_NAME: &str = ".ccpanes-default-skills-version";
const CODEX_SKILL_FILE_NAME: &str = "SKILL.md";

/// Skill 清单文件
#[derive(Debug, Deserialize)]
struct SkillManifest {
    namespace: String,
    #[serde(default)]
    variables: HashMap<String, String>,
    skills: Vec<SkillEntry>,
}

/// 单个 Skill 条目
#[derive(Debug, Deserialize)]
struct SkillEntry {
    name: String,
    file: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedCommand {
    file_name: String,
    content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedCodexSkill {
    dir_name: String,
    skill_md: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedBundle {
    namespace: String,
    commands: Vec<RenderedCommand>,
    codex_skills: Vec<RenderedCodexSkill>,
}

/// 默认 Skill 发布服务
pub struct DefaultSkillService {
    /// 模板所在目录（来自 Tauri 资源目录）
    templates_dir: PathBuf,
}

impl DefaultSkillService {
    /// 创建服务实例
    ///
    /// `templates_dir` 指向包含 `manifest.json` 和 `.md` 模板的目录
    pub fn new(templates_dir: PathBuf) -> Self {
        Self { templates_dir }
    }

    /// 将所有默认 Skill 发布到支持的 CLI 用户目录
    pub fn inject_all(&self, registry: &CliToolRegistry, app_version: &str) {
        let manifest_path = self.templates_dir.join("manifest.json");
        let manifest = match Self::load_manifest(&manifest_path) {
            Some(m) => m,
            None => return,
        };

        let rendered = match self.render_bundle(&manifest) {
            Some(bundle) => bundle,
            None => return,
        };

        let command_dirs = registry.global_commands_dirs();
        if command_dirs.is_empty() {
            info!("[default_skill] No CLI tools support global commands");
        }
        for (tool_id, commands_dir) in &command_dirs {
            let target_dir = commands_dir.join(&rendered.namespace);
            self.inject_commands_for_tool(tool_id, &target_dir, &rendered, app_version);
        }

        let skill_dirs = registry.global_skills_dirs();
        if skill_dirs.is_empty() {
            info!("[default_skill] No CLI tools support global skills");
        }
        for (tool_id, skills_dir) in &skill_dirs {
            self.inject_codex_skills_for_tool(tool_id, skills_dir, &rendered, app_version);
        }
    }

    /// 加载 manifest.json
    fn load_manifest(path: &Path) -> Option<SkillManifest> {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "[default_skill] Failed to read manifest {}: {}",
                    path.display(),
                    e
                );
                return None;
            }
        };
        match serde_json::from_str(&content) {
            Ok(m) => Some(m),
            Err(e) => {
                warn!("[default_skill] Invalid manifest JSON: {}", e);
                None
            }
        }
    }

    fn render_bundle(&self, manifest: &SkillManifest) -> Option<RenderedBundle> {
        if manifest.namespace != BUNDLED_NAMESPACE {
            warn!(
                "[default_skill] Unexpected bundled namespace '{}' in manifest, using '{}'",
                manifest.namespace, BUNDLED_NAMESPACE
            );
        }
        let namespace = BUNDLED_NAMESPACE.to_string();
        let mut commands = Vec::with_capacity(manifest.skills.len());
        let mut codex_skills = Vec::with_capacity(manifest.skills.len());

        for skill in &manifest.skills {
            let template_path = self.templates_dir.join(&skill.file);
            let template = match std::fs::read_to_string(&template_path) {
                Ok(content) => content,
                Err(error) => {
                    warn!(
                        "[default_skill] Failed to read template {}: {}",
                        template_path.display(),
                        error
                    );
                    return None;
                }
            };
            let content = Self::replace_variables(&template, &manifest.variables);
            commands.push(RenderedCommand {
                file_name: skill.file.clone(),
                content: content.clone(),
            });
            codex_skills.push(RenderedCodexSkill {
                dir_name: Self::build_codex_skill_dir_name(&namespace, &skill.name),
                skill_md: Self::build_codex_skill_markdown(&namespace, &skill.name, &content),
            });
        }

        Some(RenderedBundle {
            namespace,
            commands,
            codex_skills,
        })
    }

    fn inject_commands_for_tool(
        &self,
        tool_id: &str,
        target_dir: &Path,
        rendered: &RenderedBundle,
        app_version: &str,
    ) {
        if Self::commands_target_up_to_date(target_dir, rendered, app_version) {
            info!(
                "[default_skill] {} commands already up to date (v{})",
                tool_id, app_version
            );
            return;
        }

        if let Err(error) = std::fs::create_dir_all(target_dir) {
            warn!(
                "[default_skill] Failed to create {}: {}",
                target_dir.display(),
                error
            );
            return;
        }

        Self::cleanup_stale_command_files(target_dir, rendered);

        let mut success_count = 0usize;
        for command in &rendered.commands {
            let target_path = target_dir.join(&command.file_name);
            match std::fs::write(&target_path, &command.content) {
                Ok(_) => success_count += 1,
                Err(error) => warn!(
                    "[default_skill] Failed to write {}: {}",
                    target_path.display(),
                    error
                ),
            }
        }

        if success_count == rendered.commands.len() {
            if let Err(error) = std::fs::write(target_dir.join(VERSION_FILE_NAME), app_version) {
                warn!("[default_skill] Failed to write version stamp: {}", error);
            }
        } else {
            warn!(
                "[default_skill] Only {}/{} command skills succeeded for {}",
                success_count,
                rendered.commands.len(),
                tool_id
            );
        }

        info!(
            "[default_skill] Injected {}/{} command skills for {} (v{})",
            success_count,
            rendered.commands.len(),
            tool_id,
            app_version
        );
    }

    fn inject_codex_skills_for_tool(
        &self,
        tool_id: &str,
        target_root: &Path,
        rendered: &RenderedBundle,
        app_version: &str,
    ) {
        if Self::codex_target_up_to_date(target_root, rendered, app_version) {
            info!(
                "[default_skill] {} codex skills already up to date (v{})",
                tool_id, app_version
            );
            return;
        }

        if let Err(error) = std::fs::create_dir_all(target_root) {
            warn!(
                "[default_skill] Failed to create {}: {}",
                target_root.display(),
                error
            );
            return;
        }

        Self::cleanup_stale_codex_dirs(target_root, rendered);

        let mut success_count = 0usize;
        for skill in &rendered.codex_skills {
            let dir_path = target_root.join(&skill.dir_name);
            if let Err(error) = std::fs::create_dir_all(&dir_path) {
                warn!(
                    "[default_skill] Failed to create {}: {}",
                    dir_path.display(),
                    error
                );
                continue;
            }

            let skill_path = dir_path.join(CODEX_SKILL_FILE_NAME);
            match std::fs::write(&skill_path, &skill.skill_md) {
                Ok(_) => success_count += 1,
                Err(error) => warn!(
                    "[default_skill] Failed to write {}: {}",
                    skill_path.display(),
                    error
                ),
            }
        }

        if success_count == rendered.codex_skills.len() {
            if let Err(error) = std::fs::write(target_root.join(VERSION_FILE_NAME), app_version) {
                warn!(
                    "[default_skill] Failed to write codex version stamp: {}",
                    error
                );
            }
        } else {
            warn!(
                "[default_skill] Only {}/{} codex skills succeeded for {}",
                success_count,
                rendered.codex_skills.len(),
                tool_id
            );
        }

        info!(
            "[default_skill] Injected {}/{} codex skills for {} (v{})",
            success_count,
            rendered.codex_skills.len(),
            tool_id,
            app_version
        );
    }

    fn commands_target_up_to_date(
        target_dir: &Path,
        rendered: &RenderedBundle,
        app_version: &str,
    ) -> bool {
        let version_path = target_dir.join(VERSION_FILE_NAME);
        let Ok(existing_version) = std::fs::read_to_string(version_path) else {
            return false;
        };
        if existing_version.trim() != app_version {
            return false;
        }
        rendered
            .commands
            .iter()
            .all(|command| target_dir.join(&command.file_name).is_file())
    }

    fn codex_target_up_to_date(
        target_root: &Path,
        rendered: &RenderedBundle,
        app_version: &str,
    ) -> bool {
        let version_path = target_root.join(VERSION_FILE_NAME);
        let Ok(existing_version) = std::fs::read_to_string(version_path) else {
            return false;
        };
        if existing_version.trim() != app_version {
            return false;
        }
        rendered.codex_skills.iter().all(|skill| {
            target_root
                .join(&skill.dir_name)
                .join(CODEX_SKILL_FILE_NAME)
                .is_file()
        })
    }

    /// 删除 target_dir 中不在 manifest 中的旧 .md 文件
    fn cleanup_stale_command_files(target_dir: &Path, rendered: &RenderedBundle) {
        let expected: HashSet<&str> = rendered
            .commands
            .iter()
            .map(|skill| skill.file_name.as_str())
            .collect();
        let entries = match std::fs::read_dir(target_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }

            if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                if !expected.contains(name) {
                    if let Err(error) = std::fs::remove_file(&path) {
                        warn!(
                            "[default_skill] Failed to remove stale file {}: {}",
                            path.display(),
                            error
                        );
                    } else {
                        info!("[default_skill] Removed stale command file: {}", name);
                    }
                }
            }
        }
    }

    fn cleanup_stale_codex_dirs(target_root: &Path, rendered: &RenderedBundle) {
        let prefix = format!("{}-", rendered.namespace);
        let expected: HashSet<&str> = rendered
            .codex_skills
            .iter()
            .map(|skill| skill.dir_name.as_str())
            .collect();

        let entries = match std::fs::read_dir(target_root) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !name.starts_with(&prefix) || expected.contains(name) {
                continue;
            }

            if let Err(error) = std::fs::remove_dir_all(&path) {
                warn!(
                    "[default_skill] Failed to remove stale codex skill dir {}: {}",
                    path.display(),
                    error
                );
            } else {
                info!("[default_skill] Removed stale codex skill dir: {}", name);
            }
        }
    }

    fn build_codex_skill_dir_name(namespace: &str, skill_name: &str) -> String {
        format!("{}-{}", namespace, skill_name)
    }

    fn build_codex_skill_markdown(namespace: &str, skill_name: &str, content: &str) -> String {
        let dir_name = Self::build_codex_skill_dir_name(namespace, skill_name);
        let title = Self::extract_primary_title(content, skill_name);
        let description = format!("CC-Panes bundled skill: {}", title);
        format!(
            "---\nname: {}\ndescription: {}\n---\n\n{}\n",
            Self::yaml_single_quote(&dir_name),
            Self::yaml_single_quote(&description),
            content.trim()
        )
    }

    fn extract_primary_title(content: &str, fallback_name: &str) -> String {
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(title) = trimmed.strip_prefix("# ") {
                let title = title.trim();
                if !title.is_empty() {
                    return title.to_string();
                }
            }
        }
        fallback_name.replace('-', " ")
    }

    fn yaml_single_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    /// 替换模板中的 {{key}} 变量
    fn replace_variables(template: &str, variables: &HashMap<String, String>) -> String {
        let mut result = template.to_string();
        for (key, value) in variables {
            result = result.replace(&format!("{{{{{}}}}}", key), value);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cc-panes-default-skill-{}-{}",
            name,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn remove_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn test_replace_variables() {
        let mut vars = HashMap::new();
        vars.insert("app_name".to_string(), "CC-Panes".to_string());
        vars.insert("mcp_server_name".to_string(), "ccpanes".to_string());

        let template = "Use {{app_name}} with MCP server {{mcp_server_name}}.";
        let result = DefaultSkillService::replace_variables(template, &vars);
        assert_eq!(result, "Use CC-Panes with MCP server ccpanes.");
    }

    #[test]
    fn test_build_codex_skill_markdown_adds_frontmatter() {
        let markdown = DefaultSkillService::build_codex_skill_markdown(
            "ccpanes",
            "launch-task",
            "# 启动任务\n\nBody",
        );

        assert!(markdown.starts_with("---\nname: 'ccpanes-launch-task'\n"));
        assert!(markdown.contains("description: 'CC-Panes bundled skill: 启动任务'"));
        assert!(markdown.ends_with("# 启动任务\n\nBody\n"));
    }

    #[test]
    fn test_cleanup_stale_codex_dirs_only_removes_owned_prefix() {
        let root = unique_temp_dir("cleanup-codex");
        fs::create_dir_all(root.join("ccpanes-launch-task")).unwrap();
        fs::create_dir_all(root.join("ccpanes-old-skill")).unwrap();
        fs::create_dir_all(root.join("user-skill")).unwrap();

        let rendered = RenderedBundle {
            namespace: "ccpanes".to_string(),
            commands: vec![],
            codex_skills: vec![RenderedCodexSkill {
                dir_name: "ccpanes-launch-task".to_string(),
                skill_md: String::new(),
            }],
        };

        DefaultSkillService::cleanup_stale_codex_dirs(&root, &rendered);

        assert!(root.join("ccpanes-launch-task").is_dir());
        assert!(!root.join("ccpanes-old-skill").exists());
        assert!(root.join("user-skill").is_dir());
        remove_dir(&root);
    }

    #[test]
    fn test_inject_codex_skills_for_tool_writes_skill_dirs_and_version() {
        let root = unique_temp_dir("inject-codex");
        let svc = DefaultSkillService::new(PathBuf::from("/nonexistent"));
        let rendered = RenderedBundle {
            namespace: "ccpanes".to_string(),
            commands: vec![],
            codex_skills: vec![RenderedCodexSkill {
                dir_name: "ccpanes-launch-task".to_string(),
                skill_md: "---\nname: 'ccpanes-launch-task'\n---\n".to_string(),
            }],
        };

        svc.inject_codex_skills_for_tool("codex", &root, &rendered, "1.2.3");

        assert!(root.join("ccpanes-launch-task").join("SKILL.md").is_file());
        assert_eq!(
            fs::read_to_string(root.join(VERSION_FILE_NAME)).unwrap(),
            "1.2.3"
        );
        remove_dir(&root);
    }

    #[test]
    fn test_commands_target_up_to_date_requires_all_expected_files() {
        let root = unique_temp_dir("commands-uptodate");
        fs::write(root.join(VERSION_FILE_NAME), "9.9.9").unwrap();
        fs::write(root.join("launch-task.md"), "x").unwrap();
        let rendered = RenderedBundle {
            namespace: "ccpanes".to_string(),
            commands: vec![
                RenderedCommand {
                    file_name: "launch-task.md".to_string(),
                    content: "x".to_string(),
                },
                RenderedCommand {
                    file_name: "workspace.md".to_string(),
                    content: "y".to_string(),
                },
            ],
            codex_skills: vec![],
        };

        assert!(!DefaultSkillService::commands_target_up_to_date(
            &root, &rendered, "9.9.9"
        ));
        remove_dir(&root);
    }

    #[test]
    fn test_inject_all_with_missing_manifest() {
        let svc = DefaultSkillService::new(PathBuf::from("/nonexistent/path"));
        let registry = CliToolRegistry::new();
        svc.inject_all(&registry, "0.0.0");
    }
}
