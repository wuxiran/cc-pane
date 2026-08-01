use crate::models::CliTool;
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

const PAYLOAD_ENV: &str = "CC_PANES_WINDOWS_CODEX_LAUNCH_PAYLOAD";

// Windows PowerShell 5.1 removes embedded double quotes when it lowers a
// String[] to a native command line. Prefixing those quotes with one backslash
// preserves the exact argv value seen by the child process.
const BOOTSTRAP_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$payload = $env:CC_PANES_WINDOWS_CODEX_LAUNCH_PAYLOAD | ConvertFrom-Json
[Environment]::SetEnvironmentVariable('CC_PANES_WINDOWS_CODEX_LAUNCH_PAYLOAD', $null)
$nativeArgs = @()
foreach ($item in @($payload.args)) {
    $nativeArgs += ([string]$item).Replace(
        ([char]34).ToString(),
        ([char]92).ToString() + ([char]34).ToString()
    )
}
& ([string]$payload.command) @nativeArgs
exit $LASTEXITCODE
"#;

#[derive(Serialize)]
struct LaunchPayload {
    command: String,
    args: Vec<String>,
}

fn requires_powershell_bootstrap(cwd: &Path) -> bool {
    !cwd.as_os_str().to_string_lossy().is_ascii()
}

/// 是否需要用 PowerShell 作 ConPTY 根进程再拉起 Codex。
///
/// 三个条件缺一不可：**本地**启动、CLI 是 Codex、cwd 含非 ASCII 字符。
///
/// `is_local_launch` 这道门必须有：WSL/SSH 模式的 cwd 同样取项目的 Windows 路径
/// （`terminal_service.rs` 的三分支同构），少了它，中文路径下的 WSL 项目会把
/// `wsl.exe` 连同整串 argv 一起塞进 JSON payload 再过一遍 PowerShell 5.1 的引号
/// 转义——而这条链要修的本来只是「codex.exe 直接作 ConPTY 根进程时零输出」。
pub(super) fn should_bootstrap(is_local_launch: bool, cli_tool: CliTool, cwd: &Path) -> bool {
    is_local_launch && cli_tool == CliTool::Codex && requires_powershell_bootstrap(cwd)
}

pub(super) fn wrap_with_powershell(
    command: String,
    args: Vec<String>,
    env: &mut HashMap<String, String>,
) -> Result<(String, Vec<String>)> {
    let payload = serde_json::to_string(&LaunchPayload { command, args })
        .context("failed to serialize Windows Codex launch payload")?;
    env.insert(PAYLOAD_ENV.to_string(), payload);

    let encoded_script = STANDARD.encode(
        BOOTSTRAP_SCRIPT
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );

    Ok((
        "powershell.exe".to_string(),
        vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-EncodedCommand".to_string(),
            encoded_script,
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::{spawn_pty, PtyConfig};
    use std::io::Read;

    #[test]
    fn bootstrap_is_only_required_for_non_ascii_paths() {
        assert!(!requires_powershell_bootstrap(Path::new(
            r"E:\workspace\geedo"
        )));
        assert!(requires_powershell_bootstrap(Path::new(r"E:\geedo联调")));
    }

    #[test]
    fn bootstrap_is_gated_to_local_codex_launches() {
        let non_ascii = Path::new(r"E:\geedo联调");
        let ascii = Path::new(r"E:\workspace\geedo");

        // 本地 + Codex + 非 ASCII cwd：唯一命中的组合
        assert!(should_bootstrap(true, CliTool::Codex, non_ascii));

        // WSL/SSH 的 cwd 同样是项目的 Windows 路径，不能把 wsl.exe/ssh 包进 PowerShell
        assert!(!should_bootstrap(false, CliTool::Codex, non_ascii));

        // 其它 CLI 与 ASCII 路径都走原样直启
        assert!(!should_bootstrap(true, CliTool::Claude, non_ascii));
        assert!(!should_bootstrap(true, CliTool::Codex, ascii));
    }

    #[test]
    fn wrapper_keeps_original_argv_out_of_the_powershell_command_line() {
        let command = r"C:\Program Files\Codex\codex.exe".to_string();
        let args = vec![
            "-c".to_string(),
            r#"mcp_servers.ccpanes.url="http://127.0.0.1:1234/mcp?token=TOKEN""#.to_string(),
            "请只回复 OK。".to_string(),
        ];
        let mut env = HashMap::new();

        let (wrapped_command, wrapped_args) =
            wrap_with_powershell(command.clone(), args.clone(), &mut env).unwrap();

        assert_eq!(wrapped_command, "powershell.exe");
        assert!(wrapped_args.iter().any(|arg| arg == "-EncodedCommand"));
        assert!(!wrapped_args.join(" ").contains("TOKEN"));

        let payload: serde_json::Value =
            serde_json::from_str(env.get(PAYLOAD_ENV).unwrap()).unwrap();
        assert_eq!(payload["command"], command);
        assert_eq!(payload["args"], serde_json::json!(args));
    }

    #[test]
    fn encoded_script_clears_payload_before_starting_codex() {
        let mut env = HashMap::new();
        let (_, wrapped_args) =
            wrap_with_powershell("codex.exe".to_string(), vec![], &mut env).unwrap();
        let encoded = wrapped_args.last().unwrap();
        let bytes = STANDARD.decode(encoded).unwrap();
        let units = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        let script = String::from_utf16(&units).unwrap();

        assert!(script.contains("SetEnvironmentVariable"));
        assert!(script.contains("$nativeArgs"));
        assert!(script.contains("Replace"));
    }

    #[test]
    fn powershell_bootstrap_runs_a_child_in_a_non_ascii_pty() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("联调");
        std::fs::create_dir(&cwd).unwrap();

        let expected = "BOOTSTRAP_OK";
        let mut env = HashMap::new();
        let (command, args) = wrap_with_powershell(
            "cmd.exe".to_string(),
            vec![
                "/d".to_string(),
                "/c".to_string(),
                "echo".to_string(),
                expected.to_string(),
            ],
            &mut env,
        )
        .unwrap();

        let spawned = spawn_pty(PtyConfig {
            cols: 80,
            rows: 24,
            cwd,
            command,
            args,
            env,
            env_remove: Vec::new(),
        })
        .unwrap();

        let writer = spawned.writer;
        let mut reader = spawned.reader;
        let read = std::thread::spawn(move || {
            let mut output = String::new();
            reader.read_to_string(&mut output).unwrap();
            output
        });
        let status = spawned.process.wait().unwrap();
        drop(writer);
        drop(spawned.process);
        let output = read.join().unwrap();

        assert!(status.success(), "bootstrap output: {output:?}");
        assert!(output.contains(expected), "bootstrap output: {output:?}");
    }
}
