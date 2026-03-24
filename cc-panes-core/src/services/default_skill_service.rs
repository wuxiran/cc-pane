//! 默认 Skill 全局注入服务
//!
//! 应用启动时将内置 Skill 写入各 CLI 工具的用户全局命令目录
//! （如 `~/.claude/commands/ccpanes/`），使所有项目都能通过 `/ccpanes:xxx` 使用。

use cc_cli_adapters::CliToolRegistry;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Skill 清单文件
#[derive(Debug, Deserialize)]
struct SkillManifest {
    namespace: String,
    #[serde(default)]
    variables: std::collections::HashMap<String, String>,
    skills: Vec<SkillEntry>,
}

/// 单个 Skill 条目
#[derive(Debug, Deserialize)]
struct SkillEntry {
    #[allow(dead_code)]
    name: String,
    file: String,
}

/// 默认 Skill 注入服务
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

    /// 将所有默认 Skill 注入到各 CLI 工具的全局命令目录
    ///
    /// `app_version` 应为应用主版本（如 `env!("CARGO_PKG_VERSION")`），
    /// 用作版本戳判断是否需要 re-inject。
    pub fn inject_all(&self, registry: &CliToolRegistry, app_version: &str) {
        let manifest_path = self.templates_dir.join("manifest.json");
        let manifest = match Self::load_manifest(&manifest_path) {
            Some(m) => m,
            None => return,
        };

        let dirs = registry.global_commands_dirs();
        if dirs.is_empty() {
            info!("[default_skill] No CLI tools support global commands, skipping");
            return;
        }

        for (tool_id, commands_dir) in &dirs {
            let target_dir = commands_dir.join(&manifest.namespace);
            self.inject_for_tool(tool_id, &target_dir, &manifest, app_version);
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

    /// 为单个 CLI 工具注入 Skill
    fn inject_for_tool(
        &self,
        tool_id: &str,
        target_dir: &Path,
        manifest: &SkillManifest,
        app_version: &str,
    ) {
        // 检查版本戳
        let version_file = target_dir.join(".ccpanes-version");
        if version_file.exists() {
            if let Ok(existing) = std::fs::read_to_string(&version_file) {
                if existing.trim() == app_version {
                    info!(
                        "[default_skill] {} already up to date (v{}), skipping",
                        tool_id, app_version
                    );
                    return;
                }
            }
        }

        // 确保目标目录存在
        if let Err(e) = std::fs::create_dir_all(target_dir) {
            warn!(
                "[default_skill] Failed to create {}: {}",
                target_dir.display(),
                e
            );
            return;
        }

        // 清理不在 manifest 中的旧 .md 文件
        Self::cleanup_stale_files(target_dir, manifest);

        // 写入每个 Skill
        let total = manifest.skills.len();
        let mut success_count = 0;
        for skill in &manifest.skills {
            let src = self.templates_dir.join(&skill.file);
            let dest = target_dir.join(&skill.file);
            match std::fs::read_to_string(&src) {
                Ok(template) => {
                    let content = Self::replace_variables(&template, &manifest.variables);
                    if let Err(e) = std::fs::write(&dest, content) {
                        warn!("[default_skill] Failed to write {}: {}", dest.display(), e);
                    } else {
                        success_count += 1;
                    }
                }
                Err(e) => {
                    warn!(
                        "[default_skill] Failed to read template {}: {}",
                        src.display(),
                        e
                    );
                }
            }
        }

        // 仅当全部 skill 写入成功时才写入版本戳
        if success_count == total {
            if let Err(e) = std::fs::write(&version_file, app_version) {
                warn!("[default_skill] Failed to write version stamp: {}", e);
            }
        } else {
            warn!(
                "[default_skill] Only {}/{} skills succeeded for {}, version stamp NOT written",
                success_count, total, tool_id
            );
        }

        info!(
            "[default_skill] Injected {}/{} skills for {} (v{})",
            success_count, total, tool_id, app_version
        );
    }

    /// 删除 target_dir 中不在 manifest.skills 列表中的 .md 文件
    fn cleanup_stale_files(target_dir: &Path, manifest: &SkillManifest) {
        let expected: std::collections::HashSet<&str> =
            manifest.skills.iter().map(|s| s.file.as_str()).collect();

        let entries = match std::fs::read_dir(target_dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if !expected.contains(name) {
                        if let Err(e) = std::fs::remove_file(&path) {
                            warn!(
                                "[default_skill] Failed to remove stale file {}: {}",
                                path.display(),
                                e
                            );
                        } else {
                            info!("[default_skill] Removed stale skill file: {}", name);
                        }
                    }
                }
            }
        }
    }

    /// 替换模板中的 {{key}} 变量
    fn replace_variables(
        template: &str,
        variables: &std::collections::HashMap<String, String>,
    ) -> String {
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

    #[test]
    fn test_replace_variables() {
        let mut vars = std::collections::HashMap::new();
        vars.insert("app_name".to_string(), "CC-Panes".to_string());
        vars.insert("mcp_server_name".to_string(), "ccpanes".to_string());

        let template = "Use {{app_name}} with MCP server {{mcp_server_name}}.";
        let result = DefaultSkillService::replace_variables(template, &vars);
        assert_eq!(result, "Use CC-Panes with MCP server ccpanes.");
    }

    #[test]
    fn test_replace_variables_no_match() {
        let vars = std::collections::HashMap::new();
        let template = "No variables here.";
        let result = DefaultSkillService::replace_variables(template, &vars);
        assert_eq!(result, "No variables here.");
    }

    #[test]
    fn test_inject_all_with_missing_manifest() {
        let svc = DefaultSkillService::new(PathBuf::from("/nonexistent/path"));
        let registry = CliToolRegistry::new();
        // Should not panic
        svc.inject_all(&registry, "0.0.0");
    }
}
