//! 开发环境检测（Node / Git / WSL / 各 CLI 工具）。
//!
//! 桌面端（Tauri 命令 `check_environment`）和 cc-panes-web（`GET /api/environment`）共用，
//! 另一台设备据此显示"claude 是否已安装、版本多少"。所有子进程调用都带 5s 超时，
//! 调用方须放在阻塞线程里执行。

use std::time::Duration;

use cc_cli_adapters::CliToolRegistry;

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

fn probe_version(binary: &str) -> (bool, Option<String>) {
    let path = which::which(binary).ok();
    let installed = path.is_some();
    let version = path.and_then(|path| {
        cc_cli_adapters::run_with_timeout(&path, &["--version".to_string()], PROBE_TIMEOUT)
    });
    (installed, version)
}

/// 首页「安装其他 Agent」按本机有哪些包管理器挑安装方式（有 brew 才推 brew 命令等）。
/// 只判有无、不跑 `--version`：brew 起一次要半秒多，这里一次要探六个。
/// 走 `resolve_executable` 而不是裸 `which`：macOS 从访达启动时 PATH 里没有 /opt/homebrew/bin。
const PACKAGE_MANAGERS: &[&str] = &["brew", "npm", "bun", "curl", "winget", "scoop"];

fn probe_package_managers() -> serde_json::Map<String, serde_json::Value> {
    PACKAGE_MANAGERS
        .iter()
        .map(|name| {
            let installed = cc_cli_adapters::resolve_executable(name).is_ok();
            ((*name).to_string(), serde_json::Value::Bool(installed))
        })
        .collect()
}

pub fn check_environment(registry: &CliToolRegistry) -> serde_json::Value {
    let (node_installed, node_version) = probe_version("node");
    let (git_installed, git_version) = probe_version("git");
    let cli_tools = registry.detect_all();
    let wsl_applicable = cfg!(target_os = "windows");
    let wsl_installed = wsl_applicable
        && which::which("wsl.exe")
            .or_else(|_| which::which("wsl"))
            .is_ok();

    serde_json::json!({
        "node": { "installed": node_installed, "version": node_version },
        "git": { "installed": git_installed, "version": git_version },
        "wsl": { "installed": wsl_installed, "version": null, "applicable": wsl_applicable },
        "cliTools": cli_tools,
        "packageManagers": probe_package_managers()
    })
}
