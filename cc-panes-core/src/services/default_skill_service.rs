//! 默认 Skill 全局发布服务
//!
//! 应用启动时将内置模板同时发布到：
//! - Claude 命令目录（如 `~/.claude/commands/ccpanes/`）
//! - Codex 技能目录（如 `~/.codex/skills/ccpanes-launch-task/SKILL.md`）

use cc_cli_adapters::{CliToolRegistry, SkillDeliveryMode};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

pub(crate) const BUNDLED_NAMESPACE: &str = "ccpanes";
pub(crate) const VERSION_FILE_NAME: &str = ".ccpanes-default-skills-version";
const CODEX_SKILL_FILE_NAME: &str = "SKILL.md";
const CURRENT_MANIFEST_SCHEMA_VERSION: u32 = 2;

/// Skill 清单文件
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillManifest {
    #[serde(default = "default_manifest_schema_version")]
    schema_version: u32,
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
    #[serde(default)]
    delivery: BundledSkillDelivery,
}

impl SkillEntry {
    fn supports_delivery_mode(&self, mode: SkillDeliveryMode) -> bool {
        match mode {
            // Pi has no CC-Panes MCP transport. Legacy entries can assume one,
            // so only an explicit, MCP-independent Pi delivery is permitted.
            SkillDeliveryMode::PiSkill => {
                self.delivery.portable
                    && !self.delivery.requires_ccpanes_mcp
                    && self.delivery.modes.contains(&SkillDeliveryMode::PiSkill)
            }
            _ => !self.delivery.portable || self.delivery.modes.contains(&mode),
        }
    }
}

/// Cross-CLI delivery metadata introduced by bundled Skill manifest v2.
///
/// Missing metadata deliberately means legacy behavior, preserving v1 manifests
/// and CLI-specific Skills unchanged.
#[derive(Debug, Clone, serde::Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BundledSkillDelivery {
    #[serde(default)]
    pub portable: bool,
    #[serde(default)]
    pub modes: Vec<SkillDeliveryMode>,
    #[serde(default)]
    pub requires_ccpanes_mcp: bool,
}

/// 内置 skill 的只读展示信息（供资源中心 / 命令返回）
#[derive(Debug, Clone, serde::Serialize)]
pub struct BundledSkillInfo {
    pub name: String,
    pub description: Option<String>,
    pub delivery: BundledSkillDelivery,
}

#[derive(Debug, Default)]
pub struct DefaultSkillCleanupReport {
    pub removed: Vec<PathBuf>,
    pub failed: Vec<(PathBuf, String)>,
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

    /// 列出内置 skill（供「资源中心」只读展示）。读取 manifest 的 name，
    /// 并尽力从各模板 YAML frontmatter 的 `description:` 解析一句简介（缺失则为 None）。
    pub fn list_bundled(&self) -> Vec<BundledSkillInfo> {
        let manifest_path = self.templates_dir.join("manifest.json");
        let manifest = match Self::load_manifest(&manifest_path) {
            Some(m) => m,
            None => return Vec::new(),
        };
        manifest
            .skills
            .iter()
            .map(|s| {
                let description = std::fs::read_to_string(self.templates_dir.join(&s.file))
                    .ok()
                    // 先做 {{app_name}} 等变量替换，否则描述里会残留占位符。
                    .map(|c| Self::replace_variables(&c, &manifest.variables))
                    .and_then(|c| Self::parse_frontmatter_description(&c));
                BundledSkillInfo {
                    name: s.name.clone(),
                    description,
                    delivery: s.delivery.clone(),
                }
            })
            .collect()
    }

    /// Render selected portable bundled Skills for a CLI that accepts only a
    /// session-level prompt. Native command/Skill delivery remains preferred
    /// whenever an adapter supports it.
    pub fn portable_session_prompt(
        &self,
        selected_skill_names: &[String],
        ccpanes_mcp_available: bool,
    ) -> Option<String> {
        let manifest_path = self.templates_dir.join("manifest.json");
        let manifest = Self::load_manifest(&manifest_path)?;
        let mut rendered = Vec::new();
        let mut seen = HashSet::new();

        for name in selected_skill_names {
            let name = name.trim();
            if name.is_empty() || !seen.insert(name) {
                continue;
            }
            let Some(skill) = manifest
                .skills
                .iter()
                .find(|skill| skill.name.as_str() == name)
            else {
                continue;
            };
            if !skill.delivery.portable
                || !skill
                    .delivery
                    .modes
                    .contains(&SkillDeliveryMode::SessionPrompt)
                || (skill.delivery.requires_ccpanes_mcp && !ccpanes_mcp_available)
            {
                continue;
            }

            let template_path = self.templates_dir.join(&skill.file);
            let template = match std::fs::read_to_string(&template_path) {
                Ok(content) => content,
                Err(error) => {
                    warn!(
                        "[default_skill] Failed to read session-prompt template {}: {}",
                        template_path.display(),
                        error
                    );
                    continue;
                }
            };
            let content = Self::replace_variables(&template, &manifest.variables);
            let body = Self::strip_frontmatter(&content);
            if !body.trim().is_empty() {
                rendered.push((skill.name.as_str(), body));
            }
        }

        if rendered.is_empty() {
            return None;
        }

        let mut prompt = String::from(
            "<ccpanes-portable-skills>\n\
             The following CC-Panes portable Skills are selected for this session. \
             Follow them when relevant to the user's request.\n",
        );
        for (name, body) in rendered {
            prompt.push_str("\n## ccpanes-");
            prompt.push_str(name);
            prompt.push('\n');
            prompt.push_str(body.trim());
            prompt.push('\n');
        }
        prompt.push_str("</ccpanes-portable-skills>");
        Some(prompt)
    }

    /// 从 markdown 顶部 `--- ... ---` frontmatter 里取 `description:` 值（CRLF 安全）。
    fn parse_frontmatter_description(content: &str) -> Option<String> {
        let trimmed = content.trim_start_matches('\u{feff}');
        let mut lines = trimmed.lines();
        if lines.next().map(|l| l.trim()) != Some("---") {
            return None;
        }
        for line in lines {
            let t = line.trim();
            if t == "---" {
                break;
            }
            if let Some(rest) = t.strip_prefix("description:") {
                let v = rest.trim().trim_matches('"').trim_matches('\'').trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
        None
    }

    fn strip_frontmatter(content: &str) -> String {
        let trimmed = content.trim_start_matches('\u{feff}');
        let mut lines = trimmed.lines();
        if lines.next().map(|line| line.trim()) != Some("---") {
            return trimmed.to_string();
        }
        for line in lines.by_ref() {
            if line.trim() == "---" {
                return lines.collect::<Vec<_>>().join("\n");
            }
        }
        trimmed.to_string()
    }

    /// 将所有默认 Skill 发布到支持的 CLI 用户目录
    pub fn inject_all(&self, registry: &CliToolRegistry, app_version: &str) {
        let manifest_path = self.templates_dir.join("manifest.json");
        let manifest = match Self::load_manifest(&manifest_path) {
            Some(m) => m,
            None => return,
        };

        let command_dirs = registry.global_commands_dirs();
        if command_dirs.is_empty() {
            info!("[default_skill] No CLI tools support global commands");
        } else {
            let rendered = match self.render_bundle(&manifest, SkillDeliveryMode::NativeCommand) {
                Some(bundle) => bundle,
                None => return,
            };
            for (tool_id, commands_dir) in &command_dirs {
                let target_dir = commands_dir.join(&rendered.namespace);
                self.inject_commands_for_tool(tool_id, &target_dir, &rendered, app_version);
            }
        }

        let skill_dirs = registry.global_skills_dirs();
        let native_skill_dirs = skill_dirs
            .iter()
            .filter(|(tool_id, _)| {
                registry_supports_skill_delivery(registry, tool_id, SkillDeliveryMode::NativeSkill)
            })
            .collect::<Vec<_>>();
        if native_skill_dirs.is_empty() {
            info!("[default_skill] No CLI tools support global skills");
        } else {
            let rendered = match self.render_bundle(&manifest, SkillDeliveryMode::NativeSkill) {
                Some(bundle) => bundle,
                None => return,
            };
            for (tool_id, skills_dir) in native_skill_dirs {
                self.inject_codex_skills_for_tool(tool_id, skills_dir, &rendered, app_version);
            }
        }

        let pi_skill_dirs = skill_dirs
            .iter()
            .filter(|(tool_id, _)| {
                registry_supports_skill_delivery(registry, tool_id, SkillDeliveryMode::PiSkill)
            })
            .collect::<Vec<_>>();
        if pi_skill_dirs.is_empty() {
            return;
        }
        let rendered = match self.render_explicit_pi_skill_bundle() {
            Some(bundle) => bundle,
            None => return,
        };
        for (tool_id, skills_dir) in pi_skill_dirs {
            self.inject_pi_skills_for_tool(tool_id, skills_dir, &rendered, app_version);
        }
    }

    /// Publish explicitly Pi-compatible bundled Skills into one Pi agent state
    /// root, such as the directory supplied through `PI_CODING_AGENT_DIR`.
    ///
    /// The target is always `<agent_root>/skills`; callers must not pass a
    /// user's shared `~/.pi/agent/skills` directory. Pi entries are rendered
    /// directly from the bundled manifest/templates and deliberately retain
    /// every existing directory in the target Skills root.
    pub fn inject_pi_skills_to_agent_root(&self, agent_root: &Path, app_version: &str) {
        let rendered = match self.render_explicit_pi_skill_bundle() {
            Some(bundle) => bundle,
            None => return,
        };
        let target_root = agent_root.join("skills");
        self.inject_pi_skills_for_tool("pi-managed", &target_root, &rendered, app_version);
    }

    pub fn cleanup_injected(registry: &CliToolRegistry) -> DefaultSkillCleanupReport {
        let mut report = DefaultSkillCleanupReport::default();

        for (_, commands_root) in registry.global_commands_dirs() {
            let target = commands_root.join(BUNDLED_NAMESPACE);
            if !target.exists() {
                continue;
            }
            match std::fs::remove_dir_all(&target) {
                Ok(()) => report.removed.push(target),
                Err(error) => report.failed.push((target, error.to_string())),
            }
        }

        for (tool_id, skills_root) in registry.global_skills_dirs() {
            if !should_cleanup_skill_root(registry, &tool_id) {
                // Pi shares this root with user-owned Agent Skills. Unlike the
                // native CLI roots, a ccpanes-* directory name alone is not an
                // ownership proof, so uninstall must not recursively remove it.
                continue;
            }
            match Self::cleanup_injected_skill_dirs(&skills_root) {
                Ok(paths) => report.removed.extend(paths),
                Err(error) => report.failed.push((skills_root, error.to_string())),
            }
        }

        report
    }

    // pub(crate)：WSL 卸载清理（uninstall_cleanup_service）对发行版内的
    // ~/.codex/skills 走同一套命名空间回收口径
    pub(crate) fn cleanup_injected_skill_dirs(target_root: &Path) -> std::io::Result<Vec<PathBuf>> {
        let mut removed = Vec::new();
        if !target_root.exists() {
            return Ok(removed);
        }

        let prefix = format!("{BUNDLED_NAMESPACE}-");
        for entry in std::fs::read_dir(target_root)? {
            let entry = entry?;
            let path = entry.path();
            let owned = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(&prefix))
                .unwrap_or(false);
            if owned && path.is_dir() {
                std::fs::remove_dir_all(&path)?;
                removed.push(path);
            }
        }

        let version_path = target_root.join(VERSION_FILE_NAME);
        if version_path.is_file() {
            std::fs::remove_file(&version_path)?;
            removed.push(version_path);
        }
        Ok(removed)
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
        match serde_json::from_str::<SkillManifest>(&content) {
            Ok(manifest)
                if (1..=CURRENT_MANIFEST_SCHEMA_VERSION).contains(&manifest.schema_version) =>
            {
                Some(manifest)
            }
            Ok(manifest) => {
                warn!(
                    "[default_skill] Unsupported manifest schema version {} (supported: 1..={})",
                    manifest.schema_version, CURRENT_MANIFEST_SCHEMA_VERSION
                );
                None
            }
            Err(e) => {
                warn!("[default_skill] Invalid manifest JSON: {}", e);
                None
            }
        }
    }

    fn render_bundle(
        &self,
        manifest: &SkillManifest,
        delivery_mode: SkillDeliveryMode,
    ) -> Option<RenderedBundle> {
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
            if !skill.supports_delivery_mode(delivery_mode) {
                continue;
            }
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

    fn render_explicit_pi_skill_bundle(&self) -> Option<RenderedBundle> {
        let manifest_path = self.templates_dir.join("manifest.json");
        let manifest = Self::load_manifest(&manifest_path)?;
        let rendered = self.render_bundle(&manifest, SkillDeliveryMode::PiSkill)?;
        if rendered.codex_skills.is_empty() {
            info!("[default_skill] No explicitly Pi-compatible bundled skills to publish");
            return None;
        }
        Some(rendered)
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
        self.inject_skills_for_tool(tool_id, target_root, rendered, app_version, true);
    }

    fn inject_pi_skills_for_tool(
        &self,
        tool_id: &str,
        target_root: &Path,
        rendered: &RenderedBundle,
        app_version: &str,
    ) {
        // Pi's directory is shared with user Skills. Only upsert the rendered
        // entries; do not infer ownership from a ccpanes-* prefix and delete it.
        self.inject_skills_for_tool(tool_id, target_root, rendered, app_version, false);
    }

    fn inject_skills_for_tool(
        &self,
        tool_id: &str,
        target_root: &Path,
        rendered: &RenderedBundle,
        app_version: &str,
        cleanup_stale: bool,
    ) {
        if Self::codex_target_up_to_date(target_root, rendered, app_version) {
            info!(
                "[default_skill] {} skills already up to date (v{})",
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

        if cleanup_stale {
            Self::cleanup_stale_codex_dirs(target_root, rendered);
        }

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
                    "[default_skill] Failed to write skill version stamp: {}",
                    error
                );
            }
        } else {
            warn!(
                "[default_skill] Only {}/{} skills succeeded for {}",
                success_count,
                rendered.codex_skills.len(),
                tool_id
            );
        }

        info!(
            "[default_skill] Injected {}/{} skills for {} (v{})",
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
        let trimmed = content.trim_start();
        if trimmed.starts_with("---\n") || trimmed.starts_with("---\r\n") {
            let mut out = trimmed.trim_end().to_string();
            out.push('\n');
            return out;
        }
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

fn registry_supports_skill_delivery(
    registry: &CliToolRegistry,
    tool_id: &str,
    mode: SkillDeliveryMode,
) -> bool {
    registry
        .get(tool_id)
        .is_some_and(|adapter| adapter.skill_delivery_modes().contains(&mode))
}

fn should_cleanup_skill_root(registry: &CliToolRegistry, tool_id: &str) -> bool {
    !registry_supports_skill_delivery(registry, tool_id, SkillDeliveryMode::PiSkill)
}

fn default_manifest_schema_version() -> u32 {
    1
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
    fn manifest_v1_and_v2_parse_with_compatible_delivery_metadata() {
        let v1: SkillManifest = serde_json::from_str(
            r#"{"namespace":"ccpanes","skills":[{"name":"legacy","file":"legacy.md"}]}"#,
        )
        .unwrap();
        assert_eq!(v1.schema_version, 1);
        assert!(!v1.skills[0].delivery.portable);
        assert!(v1.skills[0].delivery.modes.is_empty());

        let v2: SkillManifest = serde_json::from_str(
            r#"{"schemaVersion":2,"namespace":"ccpanes","skills":[{"name":"portable","file":"portable.md","delivery":{"portable":true,"modes":["nativeSkill","sessionPrompt"],"requiresCcpanesMcp":true}}]}"#,
        )
        .unwrap();
        assert_eq!(v2.schema_version, 2);
        assert!(v2.skills[0].delivery.portable);
        assert_eq!(
            v2.skills[0].delivery.modes,
            vec![
                SkillDeliveryMode::NativeSkill,
                SkillDeliveryMode::SessionPrompt
            ]
        );
        assert!(v2.skills[0].delivery.requires_ccpanes_mcp);
    }

    #[test]
    fn portable_entries_only_render_for_declared_native_delivery_modes() {
        let root = unique_temp_dir("portable-delivery");
        fs::write(root.join("command.md"), "# command").unwrap();
        fs::write(root.join("skill.md"), "# skill").unwrap();
        fs::write(root.join("legacy.md"), "# legacy").unwrap();
        let manifest = SkillManifest {
            schema_version: 2,
            namespace: BUNDLED_NAMESPACE.to_string(),
            variables: HashMap::new(),
            skills: vec![
                SkillEntry {
                    name: "command".to_string(),
                    file: "command.md".to_string(),
                    delivery: BundledSkillDelivery {
                        portable: true,
                        modes: vec![SkillDeliveryMode::NativeCommand],
                        requires_ccpanes_mcp: false,
                    },
                },
                SkillEntry {
                    name: "skill".to_string(),
                    file: "skill.md".to_string(),
                    delivery: BundledSkillDelivery {
                        portable: true,
                        modes: vec![SkillDeliveryMode::NativeSkill],
                        requires_ccpanes_mcp: false,
                    },
                },
                SkillEntry {
                    name: "legacy".to_string(),
                    file: "legacy.md".to_string(),
                    delivery: BundledSkillDelivery::default(),
                },
            ],
        };
        let service = DefaultSkillService::new(root.clone());

        let commands = service
            .render_bundle(&manifest, SkillDeliveryMode::NativeCommand)
            .unwrap();
        assert_eq!(
            commands
                .commands
                .iter()
                .map(|entry| entry.file_name.as_str())
                .collect::<Vec<_>>(),
            vec!["command.md", "legacy.md"]
        );

        let skills = service
            .render_bundle(&manifest, SkillDeliveryMode::NativeSkill)
            .unwrap();
        assert_eq!(
            skills
                .codex_skills
                .iter()
                .map(|entry| entry.dir_name.as_str())
                .collect::<Vec<_>>(),
            vec!["ccpanes-skill", "ccpanes-legacy"]
        );
        remove_dir(&root);
    }

    #[test]
    fn pi_skills_require_explicit_non_mcp_pi_delivery() {
        let root = unique_temp_dir("pi-delivery");
        fs::write(root.join("native.md"), "# native").unwrap();
        fs::write(root.join("pi.md"), "# pi").unwrap();
        fs::write(root.join("pi-mcp.md"), "# pi mcp").unwrap();
        fs::write(root.join("legacy.md"), "# legacy").unwrap();
        let manifest = SkillManifest {
            schema_version: 2,
            namespace: BUNDLED_NAMESPACE.to_string(),
            variables: HashMap::new(),
            skills: vec![
                SkillEntry {
                    name: "native".to_string(),
                    file: "native.md".to_string(),
                    delivery: BundledSkillDelivery {
                        portable: true,
                        modes: vec![SkillDeliveryMode::NativeSkill],
                        requires_ccpanes_mcp: false,
                    },
                },
                SkillEntry {
                    name: "pi".to_string(),
                    file: "pi.md".to_string(),
                    delivery: BundledSkillDelivery {
                        portable: true,
                        modes: vec![SkillDeliveryMode::PiSkill],
                        requires_ccpanes_mcp: false,
                    },
                },
                SkillEntry {
                    name: "pi-mcp".to_string(),
                    file: "pi-mcp.md".to_string(),
                    delivery: BundledSkillDelivery {
                        portable: true,
                        modes: vec![SkillDeliveryMode::PiSkill],
                        requires_ccpanes_mcp: true,
                    },
                },
                SkillEntry {
                    name: "legacy".to_string(),
                    file: "legacy.md".to_string(),
                    delivery: BundledSkillDelivery::default(),
                },
            ],
        };
        let service = DefaultSkillService::new(root.clone());

        let pi = service
            .render_bundle(&manifest, SkillDeliveryMode::PiSkill)
            .unwrap();

        assert_eq!(
            pi.codex_skills
                .iter()
                .map(|entry| entry.dir_name.as_str())
                .collect::<Vec<_>>(),
            vec!["ccpanes-pi"]
        );
        remove_dir(&root);
    }

    #[test]
    fn portable_session_prompt_respects_selection_and_mcp_requirements() {
        let root = unique_temp_dir("portable-session-prompt");
        fs::write(
            root.join("manifest.json"),
            r#"{
                "schemaVersion": 2,
                "namespace": "ccpanes",
                "skills": [
                    {
                        "name": "dispatch",
                        "file": "dispatch.md",
                        "delivery": {
                            "portable": true,
                            "modes": ["sessionPrompt"],
                            "requiresCcpanesMcp": true
                        }
                    },
                    {
                        "name": "local-review",
                        "file": "review.md",
                        "delivery": {
                            "portable": true,
                            "modes": ["sessionPrompt"],
                            "requiresCcpanesMcp": false
                        }
                    },
                    { "name": "legacy", "file": "legacy.md" }
                ]
            }"#,
        )
        .unwrap();
        fs::write(
            root.join("dispatch.md"),
            "---\nname: dispatch\n---\n# Dispatch\nUse MCP.",
        )
        .unwrap();
        fs::write(root.join("review.md"), "# Review\nInspect the diff.").unwrap();
        fs::write(root.join("legacy.md"), "# Legacy").unwrap();
        let service = DefaultSkillService::new(root.clone());
        let selected = vec![
            "local-review".to_string(),
            "dispatch".to_string(),
            "dispatch".to_string(),
            "legacy".to_string(),
        ];

        let prompt = service
            .portable_session_prompt(&selected, true)
            .expect("session prompt");
        assert!(prompt.contains("## ccpanes-local-review\n# Review"));
        assert!(prompt.contains("## ccpanes-dispatch\n# Dispatch"));
        assert!(!prompt.contains("name: dispatch"));
        assert_eq!(prompt.matches("## ccpanes-dispatch").count(), 1);
        assert!(!prompt.contains("ccpanes-legacy"));

        let without_mcp = service
            .portable_session_prompt(&selected, false)
            .expect("non-MCP session prompt");
        assert!(without_mcp.contains("ccpanes-local-review"));
        assert!(!without_mcp.contains("ccpanes-dispatch"));
        remove_dir(&root);
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
    fn test_build_codex_skill_markdown_passes_through_existing_frontmatter() {
        let raw = "---\nname: ccpanes-launch-task\ndescription: Launch a new Claude session.\n---\n\n# 启动任务\n\nBody";
        let markdown =
            DefaultSkillService::build_codex_skill_markdown("ccpanes", "launch-task", raw);

        // 已有 frontmatter 时直接透传，不再追加第二层
        assert!(markdown.starts_with("---\nname: ccpanes-launch-task\n"));
        assert_eq!(markdown.matches("---\n").count(), 2);
        assert!(markdown.ends_with("Body\n"));
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
    fn test_cleanup_injected_skill_dirs_removes_only_owned_namespace() {
        let root = unique_temp_dir("uninstall-skills");
        fs::create_dir_all(root.join("ccpanes-launch-task")).unwrap();
        fs::create_dir_all(root.join("ccpanes-old-skill")).unwrap();
        fs::create_dir_all(root.join("user-skill")).unwrap();
        fs::write(root.join(VERSION_FILE_NAME), "1.2.3").unwrap();

        let removed = DefaultSkillService::cleanup_injected_skill_dirs(&root).unwrap();

        assert_eq!(removed.len(), 3);
        assert!(!root.join("ccpanes-launch-task").exists());
        assert!(!root.join("ccpanes-old-skill").exists());
        assert!(!root.join(VERSION_FILE_NAME).exists());
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
    fn pi_skill_injection_preserves_unlisted_user_skill_dirs() {
        let root = unique_temp_dir("inject-pi");
        let preserved = root.join("ccpanes-user-skill");
        fs::create_dir_all(&preserved).unwrap();
        fs::write(preserved.join("SKILL.md"), "user content").unwrap();
        let svc = DefaultSkillService::new(PathBuf::from("/nonexistent"));
        let rendered = RenderedBundle {
            namespace: "ccpanes".to_string(),
            commands: vec![],
            codex_skills: vec![RenderedCodexSkill {
                dir_name: "ccpanes-pi-only".to_string(),
                skill_md: "---\nname: ccpanes-pi-only\ndescription: Pi-only test skill.\n---\n"
                    .to_string(),
            }],
        };

        svc.inject_pi_skills_for_tool("pi", &root, &rendered, "1.2.3");

        assert_eq!(
            fs::read_to_string(preserved.join("SKILL.md")).unwrap(),
            "user content"
        );
        assert!(root.join("ccpanes-pi-only").join("SKILL.md").is_file());
        assert_eq!(
            fs::read_to_string(root.join(VERSION_FILE_NAME)).unwrap(),
            "1.2.3"
        );
        remove_dir(&root);
    }

    #[test]
    fn managed_pi_skill_publish_renders_templates_into_agent_root_without_cleanup() {
        let root = unique_temp_dir("managed-pi");
        let templates = root.join("templates");
        fs::create_dir_all(&templates).unwrap();
        fs::write(
            templates.join("manifest.json"),
            r#"{
                "schemaVersion": 2,
                "namespace": "ccpanes",
                "skills": [
                    {
                        "name": "pi-portable",
                        "file": "pi-portable.md",
                        "delivery": {
                            "portable": true,
                            "modes": ["piSkill"],
                            "requiresCcpanesMcp": false
                        }
                    },
                    {
                        "name": "pi-needs-mcp",
                        "file": "pi-needs-mcp.md",
                        "delivery": {
                            "portable": true,
                            "modes": ["piSkill"],
                            "requiresCcpanesMcp": true
                        }
                    },
                    {
                        "name": "native-only",
                        "file": "native-only.md",
                        "delivery": {
                            "portable": true,
                            "modes": ["nativeSkill"],
                            "requiresCcpanesMcp": false
                        }
                    },
                    { "name": "legacy", "file": "legacy.md" }
                ]
            }"#,
        )
        .unwrap();
        fs::write(
            templates.join("pi-portable.md"),
            "# Pi portable\n\nRendered directly from bundled templates.",
        )
        .unwrap();
        fs::write(templates.join("pi-needs-mcp.md"), "# Pi MCP").unwrap();
        fs::write(templates.join("native-only.md"), "# Native").unwrap();
        fs::write(templates.join("legacy.md"), "# Legacy").unwrap();

        let agent_root = root.join("managed-agent");
        let preserved = agent_root.join("skills").join("ccpanes-user-skill");
        let untouched = agent_root.join("skills").join("user-skill");
        fs::create_dir_all(&preserved).unwrap();
        fs::create_dir_all(&untouched).unwrap();
        fs::write(preserved.join("SKILL.md"), "user ccpanes content").unwrap();
        fs::write(untouched.join("SKILL.md"), "user content").unwrap();

        DefaultSkillService::new(templates).inject_pi_skills_to_agent_root(&agent_root, "1.2.3");

        let skills_root = agent_root.join("skills");
        let published = skills_root.join("ccpanes-pi-portable").join("SKILL.md");
        assert!(published.is_file());
        assert!(fs::read_to_string(published)
            .unwrap()
            .contains("Rendered directly from bundled templates."));
        assert!(!skills_root.join("ccpanes-pi-needs-mcp").exists());
        assert!(!skills_root.join("ccpanes-native-only").exists());
        assert!(!skills_root.join("ccpanes-legacy").exists());
        assert_eq!(
            fs::read_to_string(preserved.join("SKILL.md")).unwrap(),
            "user ccpanes content"
        );
        assert_eq!(
            fs::read_to_string(untouched.join("SKILL.md")).unwrap(),
            "user content"
        );
        assert_eq!(
            fs::read_to_string(skills_root.join(VERSION_FILE_NAME)).unwrap(),
            "1.2.3"
        );
        remove_dir(&root);
    }

    #[test]
    fn pi_shared_skill_root_is_excluded_from_prefix_cleanup() {
        let registry = CliToolRegistry::with_builtin_adapters();

        assert!(!should_cleanup_skill_root(&registry, "pi"));
        assert!(should_cleanup_skill_root(&registry, "codex"));
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
