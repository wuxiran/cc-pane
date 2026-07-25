#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::path::Path;

use anyhow::{anyhow, Result};

use super::wsl_codex::format_toml_value_for_cli;

const WSL_COMMAND_OPTION: &str = "mcpProxyWslCommand";

pub(super) fn invocation(
    adapter_options: &HashMap<String, serde_json::Value>,
    data_dir: &Path,
    launch_id: Option<&str>,
) -> Result<Option<cc_cli_adapters::McpProxyInvocation>> {
    let Some(invocation) =
        cc_cli_adapters::mcp_proxy_invocation_from_options(adapter_options, data_dir, launch_id)
    else {
        return Ok(None);
    };
    let wsl_command = adapter_options
        .get(WSL_COMMAND_OPTION)
        .and_then(serde_json::Value::as_str)
        .filter(|value| value.starts_with('/'))
        .ok_or_else(|| anyhow!("cc-panes-ctl WSL 代理缺少已探活的 cmd.exe 绝对路径"))?;
    wrap_windows_invocation(invocation, wsl_command).map(Some)
}

fn wrap_windows_invocation(
    invocation: cc_cli_adapters::McpProxyInvocation,
    wsl_command: &str,
) -> Result<cc_cli_adapters::McpProxyInvocation> {
    validate_cmd_arg(&invocation.command)?;
    for arg in &invocation.args {
        validate_cmd_arg(arg)?;
    }

    // 参数分别交给 WSL interop 做 Windows argv 引用；call 能正确执行带空格的绝对路径。
    // 不经过 start，stdio 与终止信号继续落到唯一的直接子进程。
    let mut args = vec!["/D".to_string(), "/C".to_string(), "call".to_string()];
    args.push(invocation.command);
    args.extend(invocation.args);
    Ok(cc_cli_adapters::McpProxyInvocation {
        command: wsl_command.to_string(),
        args,
    })
}

fn validate_cmd_arg(value: &str) -> Result<()> {
    let has_unquoted_parenthesis =
        !value.chars().any(char::is_whitespace) && value.contains(['(', ')']);
    if value.contains(['\0', '\r', '\n', '"', '%', '!', '&', '|', '<', '>', '^'])
        || has_unquoted_parenthesis
    {
        return Err(anyhow!(
            "cc-panes-ctl WSL 代理参数含 cmd.exe 无法安全传递的字符"
        ));
    }
    Ok(())
}

pub(super) fn push_codex_overrides(
    args: &mut Vec<String>,
    invocation: &cc_cli_adapters::McpProxyInvocation,
) {
    args.push("-c".to_string());
    args.push(format!(
        "mcp_servers.ccpanes.command={}",
        format_toml_value_for_cli(&toml::Value::String(invocation.command.clone()))
    ));
    args.push("-c".to_string());
    args.push(format!(
        "mcp_servers.ccpanes.args={}",
        format_toml_value_for_cli(&toml::Value::Array(
            invocation
                .args
                .iter()
                .cloned()
                .map(toml::Value::String)
                .collect()
        ))
    ));
    args.push("-c".to_string());
    args.push("mcp_servers.ccpanes.enabled=true".to_string());
}

#[cfg(windows)]
pub(super) fn configure_interop_command(
    adapter_options: &mut HashMap<String, serde_json::Value>,
    wsl_path: &Path,
    distro: &str,
) -> Result<()> {
    let script = r#"cmd_path=$(command -v cmd.exe) || exit 20
timeout 3 "$cmd_path" /D /C exit /B 0 >/dev/null 2>&1 || exit 21
printf '%s' "$cmd_path""#;
    let args = vec![
        "-d".to_string(),
        distro.to_string(),
        "--".to_string(),
        "bash".to_string(),
        "--noprofile".to_string(),
        "--norc".to_string(),
        "-c".to_string(),
        script.to_string(),
    ];
    let command =
        cc_cli_adapters::run_with_timeout(wsl_path, &args, std::time::Duration::from_secs(5))
            .map(|value| value.trim().to_string())
            .filter(|value| value.starts_with('/') && !value.contains(['\r', '\n']))
            .ok_or_else(|| interop_error(distro))?;
    adapter_options.insert(WSL_COMMAND_OPTION.to_string(), serde_json::json!(command));
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn configure_interop_command(
    _adapter_options: &mut HashMap<String, serde_json::Value>,
    _wsl_path: &Path,
    _distro: &str,
) -> Result<()> {
    Err(anyhow!("WSL launch is only supported on Windows"))
}

fn interop_error(distro: &str) -> anyhow::Error {
    anyhow!(
        "WSL 发行版 {distro} 无法执行 cmd.exe：Windows interop 或 Windows PATH 注入可能已禁用；请在 /etc/wsl.conf 启用 [interop] enabled=true 与 appendWindowsPath=true，执行 wsl --shutdown 后重试，或关闭 CCPANES_MCP_PROXY"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::terminal_service::wsl_codex::append_codex_resume_args;

    #[test]
    fn uses_direct_cmd_child_with_separate_arguments() {
        let invocation = cc_cli_adapters::McpProxyInvocation {
            command: r"C:\Program Files\CC Panes\cc-panes-ctl.exe".to_string(),
            args: vec![
                "--data-dir".to_string(),
                r"D:\CC Panes Data".to_string(),
                "mcp-proxy".to_string(),
                "--launch-id".to_string(),
                "launch-42".to_string(),
            ],
        };

        let wrapped =
            wrap_windows_invocation(invocation, "/mnt/c/Windows/System32/cmd.exe").unwrap();

        assert_eq!(wrapped.command, "/mnt/c/Windows/System32/cmd.exe");
        assert_eq!(
            wrapped.args,
            vec![
                "/D",
                "/C",
                "call",
                r"C:\Program Files\CC Panes\cc-panes-ctl.exe",
                "--data-dir",
                r"D:\CC Panes Data",
                "mcp-proxy",
                "--launch-id",
                "launch-42",
            ]
        );
        assert!(!wrapped.args.iter().any(|arg| arg == "start"));
    }

    #[test]
    fn rejects_cmd_expansion_and_line_breaks() {
        for hostile in ["%TEMP%", "line\nbreak", "quoted\"value", r"D:\A&B"] {
            let invocation = cc_cli_adapters::McpProxyInvocation {
                command: "/opt/cc-panes-ctl".to_string(),
                args: vec![hostile.to_string()],
            };
            assert!(wrap_windows_invocation(invocation, "/mnt/c/cmd.exe").is_err());
        }
    }

    #[test]
    fn preserves_trailing_backslash_as_a_separate_argument() {
        let invocation = cc_cli_adapters::McpProxyInvocation {
            command: r"C:\cc-panes-ctl.exe".to_string(),
            args: vec!["--data-dir".to_string(), "D:\\".to_string()],
        };

        let wrapped = wrap_windows_invocation(invocation, "/mnt/c/cmd.exe").unwrap();

        assert_eq!(wrapped.args.last().map(String::as_str), Some("D:\\"));
    }

    #[test]
    fn codex_overrides_precede_resume() {
        let proxy = cc_cli_adapters::McpProxyInvocation {
            command: "/mnt/c/Windows/System32/cmd.exe".to_string(),
            args: vec!["/D".to_string(), "/C".to_string(), "call".to_string()],
        };
        let mut args = Vec::new();

        push_codex_overrides(&mut args, &proxy);
        append_codex_resume_args(&mut args, Some("session-123"), None);

        let resume = args.iter().position(|arg| arg == "resume").unwrap();
        assert!(args[..resume]
            .iter()
            .any(|arg| arg.starts_with("mcp_servers.ccpanes.command=")));
        assert!(args[..resume]
            .iter()
            .any(|arg| arg.starts_with("mcp_servers.ccpanes.args=")));
        assert!(!args[resume..].iter().any(|arg| arg == "-c"));
    }

    #[test]
    fn disabled_interop_error_is_actionable() {
        let message = interop_error("Ubuntu").to_string();
        assert!(message.contains("cmd.exe"));
        assert!(message.contains("enabled=true"));
        assert!(message.contains("appendWindowsPath=true"));
        assert!(message.contains("CCPANES_MCP_PROXY"));
    }
}
