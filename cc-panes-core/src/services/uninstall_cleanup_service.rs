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

        #[cfg(target_os = "windows")]
        Self::cleanup_wsl_injections(&mut report);

        self.cleanup_claude_backup(&mut report);
        self.cleanup_projects(project_paths, &mut report);
        report
    }

    /// WSL 侧注入回收：trust（codex config.toml）与 skill（codex skills /
    /// claude commands）当初经 wslpath/UNC **精准写进发行版内**，上面按宿主
    /// home 走的清理够不到——注入面与清理面必须对称。
    ///
    /// 卸载清理是用户显式发起的一次性操作，允许唤醒 WSL VM（平时「碰 wsl.exe
    /// 会保活 Vmmem」的零副作用纪律不适用于这里）。三态处置：
    /// - wsl 不可用 / 无发行版 → skipped（不算失败）
    /// - 发行版不可达（未运行且起不来 / 无 bash）→ failed（可见，不静默吞掉）
    /// - 可达 → 逐项回收，只认 CC-Panes 标记 / 命名空间，与宿主同口径
    #[cfg(target_os = "windows")]
    fn cleanup_wsl_injections(report: &mut UninstallCleanupReport) {
        use cc_cli_adapters::CodexAdapter;

        let Some(distros) = wsl_cleanup::list_distros() else {
            report.skipped.push("wsl: unavailable".to_string());
            return;
        };
        if distros.is_empty() {
            report
                .skipped
                .push("wsl: no distributions installed".to_string());
            return;
        }
        for distro in distros {
            // 基础设施发行版 CC-Panes 从不注入；跑 bash -lc 只会把「无 bash」
            // 误报成失败（wsl --shutdown 杀伤面那条 gotcha 的同款盲区）
            if is_infra_distro(&distro) {
                report
                    .skipped
                    .push(format!("wsl [{distro}]: infrastructure distribution"));
                continue;
            }
            let Some(targets) = wsl_cleanup::resolve_targets(&distro) else {
                report.failed.push(format!(
                    "wsl [{distro}]: unable to resolve injection paths (distribution unreachable?)"
                ));
                continue;
            };

            match CodexAdapter::cleanup_user_injections_at(&targets.codex_config) {
                Ok(true) => Self::push_cleaned(report, &targets.codex_config),
                Ok(false) => {}
                Err(error) => report.failed.push(format!(
                    "{}: {error}",
                    targets.codex_config.to_string_lossy()
                )),
            }
            match DefaultSkillService::cleanup_injected_skill_dirs(&targets.codex_skills) {
                Ok(paths) => {
                    for path in paths {
                        Self::push_cleaned(report, &path);
                    }
                }
                Err(error) => report.failed.push(format!(
                    "{}: {error}",
                    targets.codex_skills.to_string_lossy()
                )),
            }
            let claude_namespace = &targets.claude_commands_namespace;
            if claude_namespace.is_dir() {
                match std::fs::remove_dir_all(claude_namespace) {
                    Ok(()) => Self::push_cleaned(report, claude_namespace),
                    Err(error) => report
                        .failed
                        .push(format!("{}: {error}", claude_namespace.to_string_lossy())),
                }
            }
        }
    }

    fn cleanup_claude_backup(&self, report: &mut UninstallCleanupReport) {
        let Some(home) = dirs::home_dir() else {
            report
                .failed
                .push("~/.claude.json.ccpanes.bak: home directory unavailable".to_string());
            return;
        };
        // CC-Panes 在各 CLI 用户配置旁留的 .bak（首次改动前的留底），卸载时一并回收
        let backups = [
            home.join(".claude.json.ccpanes.bak"),
            home.join(".codex").join("config.toml.bak"),
            home.join(".grok").join("config.toml.bak"),
        ];
        for path in backups {
            if !path.exists() {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => Self::push_cleaned(report, &path),
                Err(error) => report
                    .failed
                    .push(format!("{}: {error}", path.to_string_lossy())),
            }
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

/// 基础设施发行版（Docker Desktop / Rancher / Podman 的后端）：CC-Panes 从不
/// 往里注入，且它们通常没有 bash / 常规用户 home，探测只会产出误报。
/// 仅 Windows 的 WSL 清理路径调用；测试跨平台跑，故 cfg 带 test。
#[cfg(any(target_os = "windows", test))]
fn is_infra_distro(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("docker-desktop")
        || lower.starts_with("rancher-desktop")
        || lower.starts_with("podman-machine")
}

/// 把发行版内 POSIX 绝对路径拼成宿主可达的 UNC 路径。
/// `unc_root` 来自发行版内 `wslpath -w /`（如 `\\wsl.localhost\Ubuntu\`）——
/// `wslpath -w` 对不存在的路径直接失败，所以只解析恒存在的根，其余宿主侧拼接。
/// 仅 Windows 的 WSL 清理路径调用；测试跨平台跑，故 cfg 带 test。
#[cfg(any(target_os = "windows", test))]
fn wsl_windows_path(unc_root: &str, posix_path: &str) -> std::path::PathBuf {
    let mut joined = unc_root.trim_end_matches('\\').to_string();
    for segment in posix_path.split('/').filter(|segment| !segment.is_empty()) {
        joined.push('\\');
        joined.push_str(segment);
    }
    std::path::PathBuf::from(joined)
}

#[cfg(target_os = "windows")]
mod wsl_cleanup {
    use super::wsl_windows_path;
    use crate::services::wsl_discovery_service::decode_utf16le;
    use std::path::PathBuf;
    use std::time::Duration;

    /// 停止状态的发行版会被 wsl.exe 顺带拉起，冷启动数秒；30s 之外视为不可达。
    const WSL_TIMEOUT: Duration = Duration::from_secs(30);

    pub(super) struct WslCleanupTargets {
        pub codex_config: PathBuf,
        pub codex_skills: PathBuf,
        pub claude_commands_namespace: PathBuf,
    }

    /// 带超时的 wsl.exe 调用：WSL 服务 wedged 时 `output()` 永不返回，
    /// 卸载清理不能被单个发行版拖死。
    fn run_wsl(args: Vec<String>) -> Option<std::process::Output> {
        let wsl_path = which::which("wsl.exe").ok()?;
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(
                crate::utils::no_window_command(&wsl_path)
                    .args(&args)
                    .output(),
            );
        });
        receiver
            .recv_timeout(WSL_TIMEOUT)
            .ok()?
            .ok()
            .filter(|output| output.status.success())
    }

    /// 已安装发行版清单。wsl 不可用（未安装 / 命令失败）返回 None，
    /// 与「装了但列表为空」区分开。
    pub(super) fn list_distros() -> Option<Vec<String>> {
        let output = run_wsl(vec!["--list".into(), "--quiet".into()])?;
        let text = decode_utf16le(&output.stdout);
        Some(
            text.lines()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect(),
        )
    }

    /// 解析发行版内三个注入位置的宿主 UNC 路径。路径口径与注入侧同源：
    /// codex trust/skill 用 `${CODEX_HOME:-$HOME/.codex}`（bash -lc 让登录
    /// profile 里的 CODEX_HOME 生效，同 `resolve_wsl_trust_paths`）、
    /// claude commands 用 `$HOME/.claude/commands`（同 wsl_codex.rs sync prelude）。
    pub(super) fn resolve_targets(distro: &str) -> Option<WslCleanupTargets> {
        // 脚本里**一个双引号都不能有**：wsl.exe 的 Windows argv → Linux argv 转换
        // 会搅坏内嵌双引号（实测 CreateProcess 正确转义后 bash 仍报 unexpected EOF，
        // codex.rs 的 resolve_wsl_trust_paths 带引号脚本偶发 warn 疑为同源）。
        // echo 不带 -e 不处理反斜杠，UNC 根的 `\\` 原样存活（实测验证）。
        let script = r"wslpath -w /; echo $HOME; echo ${CODEX_HOME:-$HOME/.codex}";
        let output = run_wsl(vec![
            "-d".into(),
            distro.into(),
            "bash".into(),
            "-lc".into(),
            script.into(),
        ])?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut lines = stdout.lines().map(|line| line.trim_end_matches('\r'));
        let unc_root = lines.next()?.trim().to_string();
        let home = lines.next()?.trim().to_string();
        let codex_home = lines.next()?.trim().to_string();
        if !unc_root.starts_with("\\\\") || !home.starts_with('/') || !codex_home.starts_with('/') {
            return None;
        }
        let codex_home_win = wsl_windows_path(&unc_root, &codex_home);
        Some(WslCleanupTargets {
            codex_config: codex_home_win.join("config.toml"),
            codex_skills: codex_home_win.join("skills"),
            claude_commands_namespace: wsl_windows_path(&unc_root, &home)
                .join(".claude")
                .join("commands")
                .join(super::super::default_skill_service::BUNDLED_NAMESPACE),
        })
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
    fn infra_distros_are_recognized_case_insensitively() {
        assert!(is_infra_distro("docker-desktop"));
        assert!(is_infra_distro("Docker-Desktop-data"));
        assert!(is_infra_distro("rancher-desktop"));
        assert!(is_infra_distro("podman-machine-default"));
        assert!(!is_infra_distro("Ubuntu"));
        assert!(!is_infra_distro("Ubuntu-24.04"));
        assert!(!is_infra_distro("mydocker"));
    }

    #[test]
    fn wsl_windows_path_joins_unc_root_with_posix_segments() {
        assert_eq!(
            wsl_windows_path("\\\\wsl.localhost\\Ubuntu\\", "/home/dev/.codex"),
            Path::new("\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex")
        );
        // 根不带尾反斜杠、posix 带重复分隔符也要拼对
        assert_eq!(
            wsl_windows_path("\\\\wsl.localhost\\Ubuntu", "/home//dev/"),
            Path::new("\\\\wsl.localhost\\Ubuntu\\home\\dev")
        );
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
