//! CC-Panes 内置 Skill 的应用内物化 + 旧全局注入的一次性回收。
//!
//! **所有权边界**：内置 skill 只写 CC-Panes 自己的数据目录
//! （`<data_dir>/skills/builtin`，见 `AppPaths::builtin_skills_dir`），
//! 各 CLI 在**启动时按会话挂载**指过去：
//! - Claude Code：`--plugin-dir <builtin_root>`（该目录本身是一个合法插件）
//! - Codex：`-c skills.config=[{path=..,enabled=true}]`
//!
//! 用户的 `~/.claude` / `~/.codex` **零写入**。
//!
//! 0.12.5 之前的版本会把 25 个 skill 直接写进用户的 CLI Home（`~/.codex/skills/`、
//! `~/.claude/skills/`、`~/.claude/commands/ccpanes/`，共 75 个文件），
//! 并按 `ccpanes-` 前缀删除目录——这会误删用户自建的同前缀 skill。
//! `cleanup_legacy_injected_once` 负责一次性回收这些残留，且
//! **只删内容哈希能证明是我们历史发布物的文件**：用户手改过的、自建的一律保留。

use crate::utils::atomic_file;
use cc_cli_adapters::CliToolRegistry;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

pub(crate) const BUNDLED_NAMESPACE: &str = "ccpanes";
pub(crate) const VERSION_FILE_NAME: &str = ".ccpanes-default-skills-version";
const CODEX_SKILL_FILE_NAME: &str = "SKILL.md";

/// 随包分发的历史发布物 SHA-256 清单（模板目录内）。缺失时退化为「只删空目录」，
/// 绝不退化为按前缀批量删——那正是本次要修的缺陷。
const LEGACY_HASH_FILE_NAME: &str = "legacy-skill-hashes.json";

/// 迁移幂等标记，写在 `<data_dir>/skills/` 下。存在即表示回收已跑过。
pub const LEGACY_CLEANUP_REPORT_FILE_NAME: &str = "legacy-global-skill-cleanup-v1.json";

/// managed bundle 内存放各 skill 的子目录。
/// Claude 插件约定为 `<plugin_root>/skills/<name>/SKILL.md`，Codex 的
/// `skills.config` 直接指向 `<plugin_root>/skills/<name>`，两者共用同一份内容。
pub const MANAGED_SKILLS_SUBDIR: &str = "skills";
const CLAUDE_PLUGIN_DIR: &str = ".claude-plugin";
const CLAUDE_PLUGIN_MANIFEST: &str = "plugin.json";

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

/// 历史发布物哈希清单
#[derive(Debug, Default, Deserialize)]
struct LegacySkillHashes {
    #[serde(default)]
    sha256: Vec<String>,
}

/// 内置 skill 的只读展示信息（供资源中心 / 命令返回）
#[derive(Debug, Clone, serde::Serialize)]
pub struct BundledSkillInfo {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultSkillCleanupReport {
    pub removed: Vec<PathBuf>,
    /// 命中「我们的命名空间」但**内容哈希对不上**的文件——用户手改过或自建，
    /// 一律保留并记账，便于事后向用户解释「为什么这几个还在」。
    pub preserved: Vec<PathBuf>,
    pub failed: Vec<(PathBuf, String)>,
}

impl DefaultSkillCleanupReport {
    fn merge(&mut self, other: DefaultSkillCleanupReport) {
        self.removed.extend(other.removed);
        self.preserved.extend(other.preserved);
        self.failed.extend(other.failed);
    }

    fn normalize(&mut self) {
        self.removed.sort();
        self.removed.dedup();
        self.preserved.sort();
        self.preserved.dedup();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedSkill {
    dir_name: String,
    skill_md: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedBundle {
    namespace: String,
    skills: Vec<RenderedSkill>,
}

/// 默认 Skill 物化服务
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
                }
            })
            .collect()
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

    // ---------------------------------------------------------------------
    // 物化：只写 CC-Panes 自己的目录
    // ---------------------------------------------------------------------

    /// 把内置 skill 物化到 CC-Panes managed 根目录，并使该目录成为一个
    /// **合法的 Claude 插件**（含 `.claude-plugin/plugin.json`），
    /// 从而同时满足 Claude 的 `--plugin-dir` 与 Codex 的 `skills.config`。
    ///
    /// 返回写入的 SKILL.md 路径列表。
    pub fn materialize_managed_bundle(
        &self,
        target_root: &Path,
        app_version: &str,
    ) -> Result<Vec<PathBuf>, String> {
        let manifest = Self::load_manifest(&self.templates_dir.join("manifest.json"))
            .ok_or_else(|| "bundled skill manifest is unavailable".to_string())?;
        let rendered = self
            .render_bundle(&manifest)
            .ok_or_else(|| "bundled skills could not be rendered".to_string())?;

        let skills_root = target_root.join(MANAGED_SKILLS_SUBDIR);
        std::fs::create_dir_all(&skills_root).map_err(|error| {
            format!(
                "failed to create managed skill directory {}: {error}",
                skills_root.display()
            )
        })?;

        // 先清掉本版本已下架的 skill 目录。这里的删除依据是「managed 根目录归我们所有」，
        // 与用户 CLI Home 的清理是两回事——那边必须走哈希白名单。
        Self::cleanup_stale_managed_dirs(&skills_root, &rendered)?;

        let mut written = Vec::with_capacity(rendered.skills.len());
        for skill in &rendered.skills {
            let skill_path = skills_root
                .join(&skill.dir_name)
                .join(CODEX_SKILL_FILE_NAME);
            atomic_file::write_atomic(&skill_path, &skill.skill_md).map_err(|error| {
                format!(
                    "failed to write managed skill {}: {error}",
                    skill_path.display()
                )
            })?;
            written.push(skill_path);
        }

        Self::write_claude_plugin_manifest(target_root, &rendered.namespace, app_version)?;

        // 版本戳写两处，两处各有消费方，值同源不会漂移：
        // - 插件根：本 bundle 的规范标记
        // - skills/ 子目录：WSL 同步的 `collect_wsl_codex_source_dirs` 以「源根必须有
        //   版本戳」为前置校验，而它的源根就是这个 skills/ 目录
        atomic_file::write_atomic(&target_root.join(VERSION_FILE_NAME), app_version)
            .map_err(|error| format!("failed to write managed skill version stamp: {error}"))?;
        atomic_file::write_atomic(&skills_root.join(VERSION_FILE_NAME), app_version)
            .map_err(|error| format!("failed to write managed skills version stamp: {error}"))?;

        info!(
            root = %target_root.display(),
            count = written.len(),
            version = app_version,
            "materialized CC-Panes managed skills"
        );
        Ok(written)
    }

    /// 写 Claude 插件清单。格式对齐官方插件（`name` / `description` / `author`），
    /// skill 由 Claude 从 `<root>/skills/` 自动发现，无需在清单里逐条列出。
    fn write_claude_plugin_manifest(
        target_root: &Path,
        namespace: &str,
        app_version: &str,
    ) -> Result<(), String> {
        let manifest = serde_json::json!({
            "name": namespace,
            "version": app_version,
            "description": "CC-Panes bundled skills for multi-instance CLI orchestration",
            "author": { "name": "CC-Panes" },
        });
        let payload = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("failed to serialize plugin manifest: {error}"))?;
        let path = target_root
            .join(CLAUDE_PLUGIN_DIR)
            .join(CLAUDE_PLUGIN_MANIFEST);
        atomic_file::write_atomic(&path, &payload)
            .map_err(|error| format!("failed to write {}: {error}", path.display()))
    }

    /// 删除 managed skills 根目录下不在本版 manifest 中的 skill 目录。
    ///
    /// 该目录完全由 CC-Panes 拥有，用户不应在此放东西，故按「不在期望集即删」处理是安全的。
    /// **注意这条判据只适用于 managed 根**——对用户 CLI Home 用同样判据正是历史缺陷。
    fn cleanup_stale_managed_dirs(
        skills_root: &Path,
        rendered: &RenderedBundle,
    ) -> Result<(), String> {
        let expected: HashSet<&str> = rendered
            .skills
            .iter()
            .map(|skill| skill.dir_name.as_str())
            .collect();
        let entries = match std::fs::read_dir(skills_root) {
            Ok(entries) => entries,
            Err(_) => return Ok(()),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if expected.contains(name) {
                continue;
            }
            if let Err(error) = std::fs::remove_dir_all(&path) {
                warn!(
                    "[default_skill] Failed to remove stale managed skill dir {}: {}",
                    path.display(),
                    error
                );
            } else {
                info!("[default_skill] Removed stale managed skill dir: {}", name);
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------------------
    // 旧全局注入的一次性回收（哈希白名单）
    // ---------------------------------------------------------------------

    /// 首次迁移旧版全局注入，并把完整结果作为幂等标记写入 CC-Panes 数据目录。
    /// 标记文件已存在则直接返回 `Ok(None)`，不再触碰磁盘。
    pub fn cleanup_legacy_injected_once(
        &self,
        registry: &CliToolRegistry,
        report_path: &Path,
    ) -> Result<Option<DefaultSkillCleanupReport>, String> {
        if report_path.is_file() {
            return Ok(None);
        }
        let command_roots = registry
            .global_commands_dirs()
            .into_iter()
            .map(|(_, path)| path)
            .collect::<Vec<_>>();
        let skill_roots = registry
            .global_skills_dirs()
            .into_iter()
            .map(|(_, path)| path)
            .collect::<Vec<_>>();
        let report = self.cleanup_legacy_injected_roots(&command_roots, &skill_roots);
        Self::write_cleanup_report(report_path, &report)?;
        Ok(Some(report))
    }

    pub(crate) fn cleanup_legacy_injected_roots(
        &self,
        command_roots: &[PathBuf],
        skill_roots: &[PathBuf],
    ) -> DefaultSkillCleanupReport {
        let known_hashes = self.known_published_hashes();
        let mut report = DefaultSkillCleanupReport::default();
        for root in command_roots {
            report.merge(Self::cleanup_legacy_command_root(root, &known_hashes));
        }
        for root in skill_roots {
            report.merge(Self::cleanup_legacy_skill_root(root, &known_hashes));
        }
        report.normalize();
        report
    }

    fn write_cleanup_report(
        report_path: &Path,
        report: &DefaultSkillCleanupReport,
    ) -> Result<(), String> {
        let payload = serde_json::to_vec_pretty(report)
            .map_err(|error| format!("failed to serialize legacy skill cleanup report: {error}"))?;
        atomic_file::write_atomic(report_path, &payload).map_err(|error| {
            format!(
                "failed to write legacy skill cleanup report {}: {error}",
                report_path.display()
            )
        })
    }

    /// 回收 `~/.claude/commands/ccpanes/`：逐个 `.md` 比对哈希，命中才删。
    fn cleanup_legacy_command_root(
        commands_root: &Path,
        known_hashes: &HashSet<String>,
    ) -> DefaultSkillCleanupReport {
        let mut report = DefaultSkillCleanupReport::default();
        let target = commands_root.join(BUNDLED_NAMESPACE);
        if !target.is_dir() {
            return report;
        }
        let entries = match std::fs::read_dir(&target) {
            Ok(entries) => entries,
            Err(error) => {
                report.failed.push((target, error.to_string()));
                return report;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_version_stamp =
                path.file_name().and_then(|name| name.to_str()) == Some(VERSION_FILE_NAME);
            if is_version_stamp {
                Self::remove_file(&path, &mut report);
                continue;
            }
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                report.preserved.push(path);
                continue;
            }
            if Self::path_has_known_hash(&path, known_hashes) {
                Self::remove_file(&path, &mut report);
            } else {
                report.preserved.push(path);
            }
        }
        // 只在目录被清空后才删目录本身；用户自己的文件还在就保留整个目录。
        Self::remove_dir_if_empty(&target, &mut report);
        report.normalize();
        report
    }

    /// 回收 `~/.codex/skills/` 与 `~/.claude/skills/` 下的 `ccpanes-*` 目录。
    ///
    /// 三重保护，缺一不可：
    /// 1. 目录名必须是我们的命名空间前缀；
    /// 2. 目录里除 `SKILL.md` 外不能有别的东西（用户加了 assets 就说明他在用）；
    /// 3. `SKILL.md` 的内容哈希必须命中历史发布物清单。
    fn cleanup_legacy_skill_root(
        skills_root: &Path,
        known_hashes: &HashSet<String>,
    ) -> DefaultSkillCleanupReport {
        let mut report = DefaultSkillCleanupReport::default();
        if !skills_root.is_dir() {
            return report;
        }
        let prefix = format!("{BUNDLED_NAMESPACE}-");
        let entries = match std::fs::read_dir(skills_root) {
            Ok(entries) => entries,
            Err(error) => {
                report
                    .failed
                    .push((skills_root.to_path_buf(), error.to_string()));
                return report;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let owned_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(&prefix))
                .unwrap_or(false);
            if !owned_name || !path.is_dir() {
                continue;
            }
            let skill_path = path.join(CODEX_SKILL_FILE_NAME);
            if Self::dir_contains_only_skill_file(&path)
                && Self::path_has_known_hash(&skill_path, known_hashes)
            {
                match std::fs::remove_dir_all(&path) {
                    Ok(()) => report.removed.push(path),
                    Err(error) => report.failed.push((path, error.to_string())),
                }
            } else {
                report.preserved.push(path);
            }
        }
        let version_path = skills_root.join(VERSION_FILE_NAME);
        if version_path.is_file() {
            Self::remove_file(&version_path, &mut report);
        }
        report.normalize();
        report
    }

    /// 读取随包分发的历史发布物哈希清单。清单缺失时返回空集——
    /// 结果是「什么都不删、全部 preserved」，这是安全的降级方向。
    fn known_published_hashes(&self) -> HashSet<String> {
        let path = self.templates_dir.join(LEGACY_HASH_FILE_NAME);
        let Ok(content) = std::fs::read_to_string(&path) else {
            warn!(
                "[default_skill] legacy hash manifest missing at {}; legacy cleanup will preserve everything",
                path.display()
            );
            return HashSet::new();
        };
        match serde_json::from_str::<LegacySkillHashes>(&content) {
            Ok(parsed) => parsed
                .sha256
                .into_iter()
                .map(|hash| hash.trim().to_ascii_lowercase())
                .filter(|hash| !hash.is_empty())
                .collect(),
            Err(error) => {
                warn!("[default_skill] invalid legacy hash manifest: {}", error);
                HashSet::new()
            }
        }
    }

    fn path_has_known_hash(path: &Path, known_hashes: &HashSet<String>) -> bool {
        if known_hashes.is_empty() {
            return false;
        }
        let Ok(bytes) = std::fs::read(path) else {
            return false;
        };
        // CRLF 归一后再比：Windows 上历史写入可能带 \r\n，内容其实一致。
        let normalized = Self::normalize_newlines(&bytes);
        known_hashes.contains(&Self::sha256_hex(&normalized))
            || known_hashes.contains(&Self::sha256_hex(&bytes))
    }

    fn normalize_newlines(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len());
        let mut index = 0usize;
        while index < bytes.len() {
            if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                index += 1;
                continue;
            }
            out.push(bytes[index]);
            index += 1;
        }
        out
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    fn dir_contains_only_skill_file(dir: &Path) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        let mut seen_skill = false;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path.file_name().and_then(|name| name.to_str()) == Some(CODEX_SKILL_FILE_NAME)
            {
                seen_skill = true;
                continue;
            }
            return false;
        }
        seen_skill
    }

    fn remove_file(path: &Path, report: &mut DefaultSkillCleanupReport) {
        match std::fs::remove_file(path) {
            Ok(()) => report.removed.push(path.to_path_buf()),
            Err(error) => report.failed.push((path.to_path_buf(), error.to_string())),
        }
    }

    fn remove_dir_if_empty(dir: &Path, report: &mut DefaultSkillCleanupReport) {
        let is_empty = std::fs::read_dir(dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            report.preserved.push(dir.to_path_buf());
            return;
        }
        match std::fs::remove_dir(dir) {
            Ok(()) => report.removed.push(dir.to_path_buf()),
            Err(error) => report.failed.push((dir.to_path_buf(), error.to_string())),
        }
    }

    // ---------------------------------------------------------------------
    // 卸载清理（用户显式发起，沿用命名空间口径）
    // ---------------------------------------------------------------------

    /// 卸载时回收旧版本写入用户 CLI Home 的残留。
    ///
    /// 与 `cleanup_legacy_injected_*` 的区别：卸载是**用户显式发起**的，
    /// 目的是「把 CC-Panes 的东西全部拿走」，故按命名空间回收；
    /// 迁移期的自动清理则必须走哈希白名单，不能碰用户改过的文件。
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

        for (_, skills_root) in registry.global_skills_dirs() {
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

    // ---------------------------------------------------------------------
    // 渲染
    // ---------------------------------------------------------------------

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
        let mut skills = Vec::with_capacity(manifest.skills.len());

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
            skills.push(RenderedSkill {
                dir_name: Self::build_codex_skill_dir_name(&namespace, &skill.name),
                skill_md: Self::build_codex_skill_markdown(&namespace, &skill.name, &content),
            });
        }

        Some(RenderedBundle { namespace, skills })
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

    /// 造一个最小模板目录：manifest + 一个模板 + 哈希清单（含该模板渲染后的哈希）
    fn templates_with_hashes(root: &Path, published: &[&str]) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join("manifest.json"),
            r#"{"namespace":"ccpanes","variables":{},"skills":[{"name":"launch-task","file":"launch-task.md"}]}"#,
        )
        .unwrap();
        fs::write(
            root.join("launch-task.md"),
            "---\nname: ccpanes-launch-task\ndescription: d\n---\n\nBody",
        )
        .unwrap();
        let hashes: Vec<String> = published
            .iter()
            .map(|content| DefaultSkillService::sha256_hex(content.as_bytes()))
            .collect();
        fs::write(
            root.join(LEGACY_HASH_FILE_NAME),
            serde_json::json!({ "sha256": hashes }).to_string(),
        )
        .unwrap();
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
    fn test_materialize_writes_plugin_manifest_and_skills() {
        let templates = unique_temp_dir("materialize-templates");
        templates_with_hashes(&templates, &[]);
        let target = unique_temp_dir("materialize-target");

        let svc = DefaultSkillService::new(templates.clone());
        let written = svc.materialize_managed_bundle(&target, "1.2.3").unwrap();

        assert_eq!(written.len(), 1);
        let skill_md = target
            .join(MANAGED_SKILLS_SUBDIR)
            .join("ccpanes-launch-task")
            .join("SKILL.md");
        assert!(skill_md.is_file());

        // Claude 插件清单必须存在且是合法 JSON，name 即命名空间（决定菜单里的 `ccpanes:` 前缀）
        let manifest_path = target.join(".claude-plugin").join("plugin.json");
        assert!(manifest_path.is_file());
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        assert_eq!(parsed["name"], "ccpanes");
        assert_eq!(parsed["version"], "1.2.3");

        assert_eq!(
            fs::read_to_string(target.join(VERSION_FILE_NAME)).unwrap(),
            "1.2.3"
        );

        remove_dir(&templates);
        remove_dir(&target);
    }

    #[test]
    fn test_materialize_removes_stale_managed_skill_dirs() {
        let templates = unique_temp_dir("materialize-stale-templates");
        templates_with_hashes(&templates, &[]);
        let target = unique_temp_dir("materialize-stale-target");
        let stale = target
            .join(MANAGED_SKILLS_SUBDIR)
            .join("ccpanes-removed-skill");
        fs::create_dir_all(&stale).unwrap();

        let svc = DefaultSkillService::new(templates.clone());
        svc.materialize_managed_bundle(&target, "1.0.0").unwrap();

        assert!(!stale.exists());
        remove_dir(&templates);
        remove_dir(&target);
    }

    /// **核心回归锁**：迁移清理只删内容哈希命中的发布物。
    /// 用户自建的、手改过的一律保留——这是本次改动要修的历史缺陷。
    #[test]
    fn test_legacy_cleanup_preserves_user_authored_and_modified_skills() {
        let published = "---\nname: ccpanes-launch-task\n---\n\nPublished body\n";
        let templates = unique_temp_dir("legacy-templates");
        templates_with_hashes(&templates, &[published]);

        let skills_root = unique_temp_dir("legacy-skills-root");

        // ① 我们发布的原样文件 → 应被删
        let pristine = skills_root.join("ccpanes-launch-task");
        fs::create_dir_all(&pristine).unwrap();
        fs::write(pristine.join("SKILL.md"), published).unwrap();

        // ② 同前缀但用户自建 → 必须保留
        let user_authored = skills_root.join("ccpanes-mine");
        fs::create_dir_all(&user_authored).unwrap();
        fs::write(user_authored.join("SKILL.md"), "my own skill").unwrap();

        // ③ 我们发布过但用户改过 → 必须保留
        let modified = skills_root.join("ccpanes-recall");
        fs::create_dir_all(&modified).unwrap();
        fs::write(modified.join("SKILL.md"), "---\nname: x\n---\nEDITED").unwrap();

        // ④ 与我们无关的目录 → 不碰
        let unrelated = skills_root.join("user-skill");
        fs::create_dir_all(&unrelated).unwrap();

        let svc = DefaultSkillService::new(templates.clone());
        let report = svc.cleanup_legacy_injected_roots(&[], std::slice::from_ref(&skills_root));

        assert!(!pristine.exists(), "published skill should be removed");
        assert!(user_authored.is_dir(), "user-authored skill must survive");
        assert!(modified.is_dir(), "user-modified skill must survive");
        assert!(unrelated.is_dir(), "unrelated skill must survive");

        assert!(report.removed.iter().any(|p| p == &pristine));
        assert!(report.preserved.iter().any(|p| p == &user_authored));
        assert!(report.preserved.iter().any(|p| p == &modified));

        remove_dir(&templates);
        remove_dir(&skills_root);
    }

    /// 哈希清单缺失时必须「什么都不删」，而不是退化成按前缀批量删。
    #[test]
    fn test_legacy_cleanup_without_hash_manifest_removes_nothing() {
        let templates = unique_temp_dir("legacy-nohash-templates");
        fs::create_dir_all(&templates).unwrap();
        let skills_root = unique_temp_dir("legacy-nohash-skills");
        let owned = skills_root.join("ccpanes-launch-task");
        fs::create_dir_all(&owned).unwrap();
        fs::write(owned.join("SKILL.md"), "anything").unwrap();

        let svc = DefaultSkillService::new(templates.clone());
        let report = svc.cleanup_legacy_injected_roots(&[], std::slice::from_ref(&skills_root));

        assert!(owned.is_dir(), "must not delete without a hash manifest");
        assert!(report.removed.is_empty());

        remove_dir(&templates);
        remove_dir(&skills_root);
    }

    /// 目录里除 SKILL.md 外还有别的文件 → 说明用户在用，即使哈希命中也保留。
    #[test]
    fn test_legacy_cleanup_preserves_dir_with_extra_files() {
        let published = "---\nname: ccpanes-launch-task\n---\n\nPublished body\n";
        let templates = unique_temp_dir("legacy-extra-templates");
        templates_with_hashes(&templates, &[published]);
        let skills_root = unique_temp_dir("legacy-extra-skills");
        let owned = skills_root.join("ccpanes-launch-task");
        fs::create_dir_all(&owned).unwrap();
        fs::write(owned.join("SKILL.md"), published).unwrap();
        fs::write(owned.join("notes.md"), "user notes").unwrap();

        let svc = DefaultSkillService::new(templates.clone());
        svc.cleanup_legacy_injected_roots(&[], std::slice::from_ref(&skills_root));

        assert!(owned.is_dir(), "dir with user files must survive");

        remove_dir(&templates);
        remove_dir(&skills_root);
    }

    /// CRLF 归一：Windows 上历史写入带 \r\n，内容一致时仍应识别为发布物。
    #[test]
    fn test_legacy_cleanup_matches_crlf_variant() {
        let published = "---\nname: ccpanes-launch-task\n---\n\nPublished body\n";
        let templates = unique_temp_dir("legacy-crlf-templates");
        templates_with_hashes(&templates, &[published]);
        let skills_root = unique_temp_dir("legacy-crlf-skills");
        let owned = skills_root.join("ccpanes-launch-task");
        fs::create_dir_all(&owned).unwrap();
        fs::write(owned.join("SKILL.md"), published.replace('\n', "\r\n")).unwrap();

        let svc = DefaultSkillService::new(templates.clone());
        svc.cleanup_legacy_injected_roots(&[], std::slice::from_ref(&skills_root));

        assert!(!owned.exists(), "CRLF variant should still be recognized");

        remove_dir(&templates);
        remove_dir(&skills_root);
    }

    #[test]
    fn test_legacy_cleanup_once_is_idempotent() {
        let templates = unique_temp_dir("legacy-once-templates");
        templates_with_hashes(&templates, &[]);
        let data_dir = unique_temp_dir("legacy-once-data");
        let report_path = data_dir.join(LEGACY_CLEANUP_REPORT_FILE_NAME);

        let svc = DefaultSkillService::new(templates.clone());
        let registry = CliToolRegistry::new();

        // 第一次：跑了，写下标记
        let first = svc
            .cleanup_legacy_injected_once(&registry, &report_path)
            .unwrap();
        assert!(first.is_some());
        assert!(report_path.is_file());

        // 第二次：标记已在，直接跳过
        let second = svc
            .cleanup_legacy_injected_once(&registry, &report_path)
            .unwrap();
        assert!(second.is_none());

        remove_dir(&templates);
        remove_dir(&data_dir);
    }

    #[test]
    fn test_command_root_cleanup_preserves_unknown_files() {
        let published = "# published command\n";
        let templates = unique_temp_dir("legacy-cmd-templates");
        templates_with_hashes(&templates, &[published]);
        let commands_root = unique_temp_dir("legacy-cmd-root");
        let ns = commands_root.join(BUNDLED_NAMESPACE);
        fs::create_dir_all(&ns).unwrap();
        fs::write(ns.join("launch-task.md"), published).unwrap();
        fs::write(ns.join("my-own.md"), "mine").unwrap();

        let svc = DefaultSkillService::new(templates.clone());
        svc.cleanup_legacy_injected_roots(std::slice::from_ref(&commands_root), &[]);

        assert!(!ns.join("launch-task.md").exists());
        assert!(ns.join("my-own.md").is_file());
        assert!(ns.is_dir(), "namespace dir kept while user files remain");

        remove_dir(&templates);
        remove_dir(&commands_root);
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

    // -----------------------------------------------------------------
    // 随包模板的回归锁（直接读 src-tauri/resources 下的真实模板）
    // -----------------------------------------------------------------

    /// Codex 把 skill 索引行里的 description **硬截断到 116 字符**
    /// （实测 codex 0.145 的 `<skills_instructions>` 块，大量条目精确等于该长度且词中截断）。
    /// 超出部分 Codex 永远看不到，所以排除条款绝不能只写在 description 尾部。
    ///
    /// 该数字来自对二进制行为的实测，可能随 Codex 升版变化——改这里时
    /// 一并复核 rollout 里的真实截断长度。
    const CODEX_DESCRIPTION_BUDGET: usize = 116;

    fn bundled_templates_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src-tauri")
            .join("resources")
            .join("claude-bundle")
            .join("default-skills")
    }

    fn each_bundled_template(mut visit: impl FnMut(&str, &str, &str)) {
        let root = bundled_templates_dir();
        let manifest = DefaultSkillService::load_manifest(&root.join("manifest.json"))
            .expect("bundled manifest must be readable");
        assert!(!manifest.skills.is_empty());
        for entry in &manifest.skills {
            let raw = fs::read_to_string(root.join(&entry.file))
                .unwrap_or_else(|error| panic!("read {}: {error}", entry.file));
            let rendered = DefaultSkillService::replace_variables(&raw, &manifest.variables);
            visit(&entry.name, &entry.file, &rendered);
        }
    }

    fn frontmatter_field(content: &str, key: &str) -> Option<String> {
        let trimmed = content.trim_start_matches('\u{feff}');
        let mut lines = trimmed.lines();
        if lines.next().map(str::trim) != Some("---") {
            return None;
        }
        for line in lines {
            if line.trim() == "---" {
                break;
            }
            if let Some(rest) = line.strip_prefix(&format!("{key}:")) {
                return Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
            }
        }
        None
    }

    /// description 的**前 116 字符**必须自足：说清做什么 + 何时用，且不半词截断。
    #[test]
    fn bundled_descriptions_fit_codex_truncation_budget() {
        each_bundled_template(|name, file, content| {
            let description = frontmatter_field(content, "description")
                .unwrap_or_else(|| panic!("{file} has no description"));
            let visible: String = description.chars().take(CODEX_DESCRIPTION_BUDGET).collect();
            assert!(
                !visible.trim().is_empty(),
                "{name}: empty visible description"
            );
            // 截断点落在词中间 = 前 116 字符不是一句完整的话
            if description.chars().count() > CODEX_DESCRIPTION_BUDGET {
                let next = description
                    .chars()
                    .nth(CODEX_DESCRIPTION_BUDGET)
                    .unwrap_or(' ');
                let last = visible.chars().last().unwrap_or(' ');
                assert!(
                    !(last.is_ascii_alphanumeric() && next.is_ascii_alphanumeric()),
                    "{name}: description is cut mid-word at {CODEX_DESCRIPTION_BUDGET} chars; \
                     keep the leading sentence self-contained and move the rest after it"
                );
            }
        });
    }

    /// Codex 展示的是 frontmatter 的 `name:`（不是目录名），
    /// 少了前缀就会与用户/第三方 skill 撞名。
    #[test]
    fn bundled_names_carry_namespace_prefix() {
        each_bundled_template(|name, file, content| {
            let declared =
                frontmatter_field(content, "name").unwrap_or_else(|| panic!("{file} has no name"));
            assert_eq!(
                declared,
                format!("{BUNDLED_NAMESPACE}-{name}"),
                "{file}: frontmatter name must be namespaced"
            );
        });
    }

    /// `trigger:` 是自造字段，Claude 与 Codex 都不消费——留着只会误导维护者
    /// 以为它参与匹配。触发词应写在 description 或正文里。
    #[test]
    fn bundled_templates_have_no_custom_trigger_field() {
        each_bundled_template(|_, file, content| {
            assert!(
                frontmatter_field(content, "trigger").is_none(),
                "{file}: `trigger:` is consumed by no harness; fold it into description/body"
            );
        });
    }

    #[test]
    fn test_materialize_with_missing_manifest_reports_error() {
        let svc = DefaultSkillService::new(PathBuf::from("/nonexistent/path"));
        let target = unique_temp_dir("materialize-missing");
        let result = svc.materialize_managed_bundle(&target, "0.0.0");
        assert!(result.is_err());
        remove_dir(&target);
    }
}
