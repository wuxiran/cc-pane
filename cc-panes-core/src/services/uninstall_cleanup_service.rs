use super::DefaultSkillService;
use cc_cli_adapters::CliToolRegistry;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallCleanupReport {
    pub cleaned: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
}

pub struct UninstallCleanupService {
    cli_registry: Arc<CliToolRegistry>,
}

impl UninstallCleanupService {
    pub fn new(cli_registry: Arc<CliToolRegistry>) -> Self {
        Self { cli_registry }
    }

    pub fn cleanup(&self, project_paths: &[String]) -> UninstallCleanupReport {
        let mut report = UninstallCleanupReport::default();

        let skills = DefaultSkillService::cleanup_injected(&self.cli_registry);
        for path in skills.removed {
            Self::push_cleaned(&mut report, &path);
        }
        for (path, error) in skills.failed {
            report
                .failed
                .push(format!("{}: {error}", path.to_string_lossy()));
        }

        for (tool_id, _) in self.cli_registry.list_capabilities() {
            let Some(adapter) = self.cli_registry.get(&tool_id) else {
                continue;
            };
            match adapter.cleanup_user_injections() {
                Ok(paths) => {
                    for path in paths {
                        Self::push_cleaned(&mut report, &path);
                    }
                }
                Err(error) => report
                    .failed
                    .push(format!("{tool_id} user configuration: {error}")),
            }
        }

        self.cleanup_claude_backup(&mut report);
        self.cleanup_projects(project_paths, &mut report);
        report
    }

    fn cleanup_claude_backup(&self, report: &mut UninstallCleanupReport) {
        let Some(home) = dirs::home_dir() else {
            report
                .failed
                .push("~/.claude.json.ccpanes.bak: home directory unavailable".to_string());
            return;
        };
        let path = home.join(".claude.json.ccpanes.bak");
        if !path.exists() {
            return;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => Self::push_cleaned(report, &path),
            Err(error) => report
                .failed
                .push(format!("{}: {error}", path.to_string_lossy())),
        }
    }

    fn cleanup_projects(&self, project_paths: &[String], report: &mut UninstallCleanupReport) {
        for project_path in project_paths {
            let path = Path::new(project_path);
            if !path.is_dir() {
                report
                    .skipped
                    .push(format!("{project_path}: project unavailable"));
                continue;
            }

            for (tool_id, capabilities) in self.cli_registry.list_capabilities() {
                if !capabilities.supports_project_hooks {
                    continue;
                }
                let Some(adapter) = self.cli_registry.get(&tool_id) else {
                    continue;
                };
                match adapter.cleanup_project_hooks(path) {
                    Ok(paths) => {
                        for changed_path in paths {
                            Self::push_cleaned(report, &changed_path);
                        }
                    }
                    Err(error) => report
                        .failed
                        .push(format!("{project_path} [{tool_id}]: {error}")),
                }
            }
        }
    }

    fn push_cleaned(report: &mut UninstallCleanupReport, path: &Path) {
        let display = path.to_string_lossy().to_string();
        if !report.cleaned.contains(&display) {
            report.cleaned.push(display);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_cli_adapters::{ClaudeAdapter, CliToolRegistry};
    use std::fs;
    use std::sync::Arc;
    use tempfile::tempdir;

    #[test]
    fn project_cleanup_reports_changed_and_unreachable_projects() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let settings_path = project.join(".claude").join("settings.local.json");
        fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        fs::write(
            &settings_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "hooks": {
                    "SessionStart": [{
                        "matcher": "startup|resume",
                        "hooks": [{"type": "command", "command": "\"/opt/cc-panes-cli-hook\" session-init"}]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let mut registry = CliToolRegistry::new();
        registry.register(Arc::new(ClaudeAdapter::new()));
        let service = UninstallCleanupService::new(Arc::new(registry));
        let mut report = UninstallCleanupReport::default();
        service.cleanup_projects(
            &[
                project.to_string_lossy().to_string(),
                dir.path().join("missing").to_string_lossy().to_string(),
            ],
            &mut report,
        );

        assert_eq!(
            report.cleaned,
            vec![settings_path.to_string_lossy().to_string()]
        );
        assert_eq!(report.skipped.len(), 1);
        assert!(report.skipped[0].contains("missing"));
        assert!(report.failed.is_empty());
    }

    #[test]
    fn invalid_project_config_is_reported_without_overwrite() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let settings_path = project.join(".claude").join("settings.local.json");
        fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        fs::write(&settings_path, "{not-json").unwrap();

        let mut registry = CliToolRegistry::new();
        registry.register(Arc::new(ClaudeAdapter::new()));
        let service = UninstallCleanupService::new(Arc::new(registry));
        let mut report = UninstallCleanupReport::default();
        service.cleanup_projects(&[project.to_string_lossy().to_string()], &mut report);

        assert!(report.cleaned.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert_eq!(fs::read_to_string(settings_path).unwrap(), "{not-json");
    }
}
