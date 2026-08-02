//! 手动验证：Windows 本地 Codex 经 ConPTY 是否透传含 thread-id 的 OSC 标题。
//!
//! 这是确定性 resume id 绑定（osc_resume_capture）的 Windows 侧前提验证，
//! 走与运行时完全相同的 PTY 栈（portable-pty → ConPTY）。需要本机已安装并登录 codex。
//!
//! 运行：cargo test -p cc-panes-core --test manual_codex_osc_windows -- --ignored --nocapture

#![cfg(windows)]

use cc_panes_core::pty::{spawn_pty, PtyConfig};
use std::collections::HashMap;
use std::io::Read;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn extract_osc_titles(data: &str) -> Vec<String> {
    let mut titles = Vec::new();
    let mut rest = data;
    while let Some(pos) = rest.find("\u{1b}]") {
        rest = &rest[pos + 2..];
        let Some(body) = rest.strip_prefix("0;").or_else(|| rest.strip_prefix("2;")) else {
            continue;
        };
        if let Some(end) = body.find(['\u{7}', '\u{1b}']) {
            titles.push(body[..end].to_string());
            rest = &body[end..];
        }
    }
    titles
}

#[test]
#[ignore = "manual verification: requires installed codex CLI and a real ConPTY"]
fn windows_codex_emits_thread_id_in_osc_title() {
    let cwd = std::env::temp_dir().join("ccpanes-osc-win-test");
    std::fs::create_dir_all(&cwd).expect("create test cwd");

    let config = PtyConfig {
        cols: 120,
        rows: 40,
        cwd,
        // cmd /C 解析 npm 的 codex shim；OSC 透传不受 wrapper 影响
        command: "cmd.exe".to_string(),
        args: vec![
            "/C".to_string(),
            "codex".to_string(),
            "-c".to_string(),
            r#"tui.terminal_title=["thread-id"]"#.to_string(),
            "--sandbox".to_string(),
            "read-only".to_string(),
        ],
        env: HashMap::new(),
        env_remove: vec![],
        resource_policy: Default::default(),
    };

    let spawn = spawn_pty(config).expect("spawn codex in ConPTY");
    let mut reader = spawn.reader;
    let mut writer = spawn.writer;
    let process = spawn.process;

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut collected = String::new();
    let mut trusted = false;
    let mut found: Option<String> = None;

    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(chunk) => {
                let text = String::from_utf8_lossy(&chunk).into_owned();
                // 应答终端能力查询，让 TUI 继续渲染
                if text.contains("\u{1b}[6n") {
                    let _ = std::io::Write::write_all(&mut writer, b"\x1b[1;1R");
                }
                if text.contains("\u{1b}]10;?") {
                    let _ =
                        std::io::Write::write_all(&mut writer, b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
                }
                if text.contains("\u{1b}]11;?") {
                    let _ =
                        std::io::Write::write_all(&mut writer, b"\x1b]11;rgb:0000/0000/0000\x1b\\");
                }
                collected.push_str(&text);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !trusted && collected.contains("continue") {
                    let _ = std::io::Write::write_all(&mut writer, b"\r");
                    trusted = true;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        let titles = extract_osc_titles(&collected);
        if let Some(title) = titles
            .iter()
            .rev()
            .find(|t| t.len() >= 23 && t.chars().take(8).all(|c| c.is_ascii_hexdigit()))
        {
            found = Some(title.clone());
            break;
        }
    }

    let _ = process.kill();

    let titles = extract_osc_titles(&collected);
    println!("captured {} bytes, osc titles: {titles:?}", collected.len());
    assert!(
        found.is_some(),
        "expected an OSC title containing a thread-id prefix; got titles: {titles:?}"
    );
    println!(
        "thread-id title confirmed on Windows ConPTY: {}",
        found.unwrap()
    );
}
