//! 内置 skill 物化的 app 侧入口：boot 与设置保存共用一处，门（`SkillGateContext`）从设置算。
//!
//! 只写 `<data_dir>/skills/builtin`，各 CLI 按会话挂载（Claude `--plugin-dir` / Codex
//! `skills.config`）；WSL Codex 在下一次启动时按同一目录同步（含删除分支）。

use cc_panes_core::models::settings::AppSettings;
use cc_panes_core::services::{DefaultSkillService, SkillGateContext};
use cc_panes_core::utils::AppPaths;
use std::path::{Path, PathBuf};

pub fn bundled_templates_dir(resource_dir: &Path) -> PathBuf {
    resource_dir
        .join("resources")
        .join("claude-bundle")
        .join("default-skills")
}

/// 物化内置 skill 到 managed 目录。返回写入的 SKILL.md 列表。
pub fn materialize_bundled_skills(
    resource_dir: &Path,
    app_paths: &AppPaths,
    settings: &AppSettings,
    app_version: &str,
) -> Result<Vec<PathBuf>, String> {
    let svc = DefaultSkillService::new(bundled_templates_dir(resource_dir));
    let gate = SkillGateContext::from_app_settings(settings);
    svc.materialize_managed_bundle_gated(&app_paths.builtin_skills_dir(), app_version, &gate)
}

/// 设置保存后是否需要重物化：只有门控相关的键变了才动（物化会碰磁盘、清目录）。
pub fn skill_gate_changed(previous: &AppSettings, next: &AppSettings) -> bool {
    SkillGateContext::from_app_settings(previous) != SkillGateContext::from_app_settings(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_change_detection_only_fires_on_gated_keys() {
        let base = AppSettings::default();
        let mut toggled = AppSettings::default();
        toggled.performance.heavy_gate_enabled = true;
        assert!(skill_gate_changed(&base, &toggled));

        let mut unrelated = AppSettings::default();
        unrelated.performance.heavy_gate_timeout_secs = 42;
        assert!(!skill_gate_changed(&base, &unrelated));
    }
}
