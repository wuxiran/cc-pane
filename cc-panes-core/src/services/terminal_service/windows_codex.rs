use crate::models::CliTool;
use std::path::Path;
use std::path::PathBuf;

fn requires_wrapper(cwd: &Path) -> bool {
    !cwd.as_os_str().to_string_lossy().is_ascii()
}

/// 是否需要给 Codex 做非 ASCII cwd 直启改写（`-C` 方案）。
///
/// 三个条件缺一不可：**本地**启动、CLI 是 Codex、cwd 含非 ASCII 字符。
/// WSL/SSH 模式的 cwd 同样取项目的 Windows 路径（三分支同构），不能把它们
/// 的 `wsl.exe` argv 加 `-C`。
pub(super) fn should_bootstrap(is_local_launch: bool, cli_tool: CliTool, cwd: &Path) -> bool {
    is_local_launch && cli_tool == CliTool::Codex && requires_wrapper(cwd)
}

/// 非 ASCII cwd 的 codex 直启改写：ConPTY 根进程 = codex.exe，spawn cwd 落 ASCII
/// 目录（绕开「codex.exe 直接作 ConPTY 根进程 + 非 ASCII cwd 零输出」的原始
/// bug），codex 用 `-C <原 cwd>` 自己 cd 进中文项目目录。
///
/// 为什么不再包 cmd/powershell shim：任何包装进程插在 codex.exe 与 ConPTY 之间
/// 都会破坏输入链路（活体实锤：shim 会话 banner 能渲染、composer 不回显任何
/// 按键；直启 + `-C` 探针回显正常）。
pub(super) fn rewrite_with_cd_arg(mut args: Vec<String>, cwd: &Path) -> (PathBuf, Vec<String>) {
    let spawn_cwd = ascii_spawn_cwd();
    let mut rewritten = Vec::with_capacity(args.len() + 2);
    rewritten.push("-C".to_string());
    rewritten.push(cwd.as_os_str().to_string_lossy().into_owned());
    rewritten.append(&mut args);
    (spawn_cwd, rewritten)
}

/// `-C` 直启的 spawn cwd：必须 ASCII，优先 %TEMP%，兜底系统 Temp。
fn ascii_spawn_cwd() -> PathBuf {
    let temp = std::env::temp_dir();
    if temp.as_os_str().to_string_lossy().is_ascii() {
        temp
    } else {
        PathBuf::from(r"C:\Windows\Temp")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::{spawn_pty, PtyConfig};
    use std::collections::HashMap;
    use std::io::Read;

    #[test]
    fn bootstrap_is_only_required_for_non_ascii_paths() {
        assert!(!requires_wrapper(Path::new(r"E:\workspace\geedo")));
        assert!(requires_wrapper(Path::new(r"E:\geedo联调")));
    }

    #[test]
    fn cd_rewrite_prepends_dash_c_and_picks_ascii_spawn_cwd() {
        let (spawn_cwd, args) = rewrite_with_cd_arg(
            vec!["--dangerously-bypass-approvals-and-sandbox".to_string()],
            Path::new(r"C:\Users\ZhuanZ\Desktop\学习笔记"),
        );
        assert!(spawn_cwd.as_os_str().to_string_lossy().is_ascii());
        assert_eq!(args[0], "-C");
        assert_eq!(args[1], r"C:\Users\ZhuanZ\Desktop\学习笔记");
        assert_eq!(args[2], "--dangerously-bypass-approvals-and-sandbox");
    }

    #[test]
    fn bootstrap_is_gated_to_local_codex_launches() {
        let non_ascii = Path::new(r"E:\geedo联调");
        let ascii = Path::new(r"E:\workspace\geedo");

        // 本地 + Codex + 非 ASCII cwd：唯一命中的组合
        assert!(should_bootstrap(true, CliTool::Codex, non_ascii));

        // WSL/SSH 的 cwd 同样是项目的 Windows 路径，不能把 wsl.exe/ssh 包进 wrapper
        assert!(!should_bootstrap(false, CliTool::Codex, non_ascii));

        // 其它 CLI 与 ASCII 路径都走原样直启
        assert!(!should_bootstrap(true, CliTool::Claude, non_ascii));
        assert!(!should_bootstrap(true, CliTool::Codex, ascii));
    }

    /// 真机探针（--ignored）：真 codex 直启后往 composer 打字，
    /// 输出里出现回显 = PTY 输入链路和 codex 输入处理都正常（问题在前端）。
    #[test]
    #[ignore = "manual probe: needs real codex install"]
    fn probe_real_codex_composer_echo() {
        probe_codex_input(vec![]);
    }

    /// 真机探针 2（--ignored）：带额外 -c 参数启动 codex。
    /// 参数取环境变量 CC_PANES_PROBE_ARGS（多个值用 \x1f 分隔），未设则用死 MCP url。
    #[test]
    #[ignore = "manual probe: needs real codex install"]
    fn probe_real_codex_composer_echo_with_dead_mcp() {
        let extra = match std::env::var("CC_PANES_PROBE_ARGS") {
            Ok(raw) => raw
                .split('\u{1f}')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>(),
            Err(_) => {
                vec![r#"mcp_servers.ccpanes.url="http://127.0.0.1:1/mcp?token=dead""#.to_string()]
            }
        };
        let mut args = Vec::new();
        let raw = std::env::var("CC_PANES_PROBE_DIRECT").is_ok();
        for value in extra {
            if !raw {
                args.push("-c".to_string());
            }
            args.push(value);
        }
        probe_codex_input(args);
    }

    fn probe_codex_input(extra_args: Vec<String>) {
        use std::io::Write;
        use std::sync::{Arc, Mutex};
        let cwd = std::env::var("CC_PANES_PROBE_CWD")
            .unwrap_or_else(|_| r"C:\Users\ZhuanZ\Desktop\学习笔记".to_string());
        // 生产已改为直启（-C 方案），探针同构：一律直启。
        let (command, args) = (
            std::env::var("CC_PANES_PROBE_CMD").unwrap_or_else(|_| which_codex()),
            extra_args.clone(),
        );
        let spawned = spawn_pty(PtyConfig {
            cols: 120,
            rows: 32,
            cwd: std::path::PathBuf::from(cwd),
            command,
            args,
            env: HashMap::new(),
            env_remove: Vec::new(),
            resource_policy: Default::default(),
        })
        .unwrap();
        let mut writer = spawned.writer;
        let mut reader = spawned.reader;
        let sink = Arc::new(Mutex::new(String::new()));
        let sink_for_thread = Arc::clone(&sink);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => sink_for_thread
                        .lock()
                        .unwrap()
                        .push_str(&String::from_utf8_lossy(&buf[..n])),
                }
            }
        });

        std::thread::sleep(std::time::Duration::from_secs(6));
        writer.write_all(b"xyzzy-input-probe").unwrap();
        writer.flush().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut echoed = false;
        while std::time::Instant::now() < deadline {
            if sink.lock().unwrap().contains("xyzzy-input-probe") {
                echoed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        // 焦点门控探针：focus-out 报告后再打字，若不回显 = codex 按焦点态禁输入。
        writer.write_all(b"\x1b[O").unwrap();
        writer.flush().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        writer.write_all(b"focusgate-probe-2").unwrap();
        writer.flush().unwrap();
        let deadline2 = std::time::Instant::now() + std::time::Duration::from_secs(6);
        let mut echoed2 = false;
        while std::time::Instant::now() < deadline2 {
            if sink.lock().unwrap().contains("focusgate-probe-2") {
                echoed2 = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let tail = {
            let s = sink.lock().unwrap();
            s.chars().rev().take(400).collect::<String>()
        };
        // 落盘活体 VT 流（含打字回显），供前端渲染管线回归测试回放。
        let dump = std::env::temp_dir().join("ccpanes-codex-vt-capture.bin");
        let _ = std::fs::write(&dump, sink.lock().unwrap().as_bytes());
        let _ = spawned.process.kill();
        println!(
            "PROBE echoed={echoed} echoed_after_focus_out={echoed2} dump={} tail={tail:?}",
            dump.display()
        );
        assert!(
            echoed || !extra_args.is_empty(),
            "codex composer did not echo typed input; tail={tail:?}"
        );
    }

    /// 探针直启用原生 exe：.cmd 不能作 ConPTY 根进程（CreateProcess 不执行 .cmd）。
    /// 优先 `where codex` 里的 .exe，其次 npm vendor 常见路径，最后兜底裸名。
    fn which_codex() -> String {
        if let Ok(out) = std::process::Command::new("where").arg("codex").output() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout)
                .lines()
                .find(|l| l.to_lowercase().ends_with("codex.exe"))
            {
                return line.trim().to_string();
            }
        }
        let vendor = std::env::var("APPDATA").map(|root| {
            format!(
                r"{root}\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
            )
        });
        if let Ok(path) = vendor {
            if std::path::Path::new(&path).exists() {
                return path;
            }
        }
        "codex".to_string()
    }
}
