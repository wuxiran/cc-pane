//! `cc-panes-ctl run` 集成测试：真起二进制，门禁不可达 / 透传 / 排队→授予→归还三条路。
//!
//! 门禁用一个单线程的最小 HTTP 服务替身（std TcpListener），只认 `/api/heavy-jobs/*`，
//! 记录收到的 (path, body)。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::thread;

fn ctl() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_cc-panes-ctl"));
    command
        .env_remove("CC_PANES_API_BASE_URL")
        .env_remove("CC_PANES_API_PORT")
        .env_remove("CC_PANES_API_TOKEN")
        .env_remove("CC_PANES_PTY_SESSION_ID");
    command
}

fn exit_with_7() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["cmd", "/c", "exit", "7"]
    } else {
        vec!["sh", "-c", "exit 7"]
    }
}

fn echo_hi() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["cmd", "/c", "echo", "hi"]
    } else {
        vec!["echo", "hi"]
    }
}

fn run_with_gate(base_url: &str, heavy: bool, cmd: &[&str]) -> Output {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let mut command = ctl();
    command.arg("--data-dir").arg(data_dir.path()).arg("run");
    if heavy {
        command.arg("--heavy");
    }
    command
        .arg("--")
        .args(cmd)
        .env("CC_PANES_API_BASE_URL", base_url)
        .env("CC_PANES_API_TOKEN", "test-token")
        .env("CC_PANES_PTY_SESSION_ID", "session-test")
        .output()
        .expect("spawn ctl")
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

#[test]
fn run_without_heavy_is_plain_exec_with_exit_code() {
    let output = run_with_gate("http://127.0.0.1:1", false, &exit_with_7());
    assert_eq!(output.status.code(), Some(7));
    assert!(
        stderr_of(&output).is_empty(),
        "no gate chatter without --heavy"
    );

    let output = run_with_gate("http://127.0.0.1:1", false, &echo_hi());
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hi");
}

#[test]
fn heavy_with_unreachable_gate_passes_through_and_keeps_exit_code() {
    // 127.0.0.1:1 没人监听 → 连接被拒，立刻回退本地执行
    let output = run_with_gate("http://127.0.0.1:1", true, &exit_with_7());
    assert_eq!(output.status.code(), Some(7));
    let stderr = stderr_of(&output);
    assert!(stderr.contains("门禁不可达"), "stderr: {stderr}");

    let output = run_with_gate("http://127.0.0.1:1", true, &echo_hi());
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hi");
}

#[test]
fn run_without_command_is_an_argument_error() {
    let output = ctl().args(["run", "--heavy"]).output().expect("spawn ctl");
    // clap：`--` 之后必须有命令
    assert_ne!(output.status.code(), Some(0));
}

// ---- 门禁替身 ----

type Recorded = Arc<Mutex<Vec<(String, String)>>>;

/// 按请求序号给出响应体的脚本。
fn spawn_gate(script: Vec<(&'static str, &'static str)>) -> (String, Recorded) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let base_url = format!("http://{}", listener.local_addr().expect("addr"));
    let recorded: Recorded = Arc::new(Mutex::new(Vec::new()));
    let seen = recorded.clone();
    thread::spawn(move || {
        let mut index = 0usize;
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let Some((path, auth, body)) = read_request(stream.try_clone().expect("clone")) else {
                continue;
            };
            seen.lock().unwrap().push((path.clone(), body));
            let (response_body, status) = if auth != "Bearer test-token" {
                (
                    r#"{"error":"Invalid or missing Bearer token"}"#,
                    "401 Unauthorized",
                )
            } else {
                let scripted = script
                    .get(index)
                    .filter(|(expected_path, _)| *expected_path == path.as_str())
                    .map(|(_, body)| *body);
                match scripted {
                    Some(body) => {
                        index += 1;
                        (body, "200 OK")
                    }
                    None => default_reply(&path),
                }
            };
            write_response(stream, status, response_body);
        }
    });
    (base_url, recorded)
}

fn default_reply(path: &str) -> (&'static str, &'static str) {
    match path {
        "/api/heavy-jobs/heartbeat" => (r#"{"alive":true}"#, "200 OK"),
        "/api/heavy-jobs/release" => (r#"{"released":true}"#, "200 OK"),
        _ => (r#"{"error":"not found"}"#, "404 Not Found"),
    }
}

fn read_request(stream: TcpStream) -> Option<(String, String, String)> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let path = request_line.split_whitespace().nth(1)?.to_string();
    let mut content_length = 0usize;
    let mut auth = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
        if lower.starts_with("authorization:") {
            auth = trimmed["authorization:".len()..].trim().to_string();
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body).ok()?;
    Some((path, auth, String::from_utf8_lossy(&body).to_string()))
}

fn write_response(mut stream: TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

#[test]
fn heavy_with_disabled_gate_is_silent_passthrough() {
    let (base_url, recorded) = spawn_gate(vec![(
        "/api/heavy-jobs/acquire",
        r#"{"outcome":"passthrough","reason":"gate disabled"}"#,
    )]);
    let output = run_with_gate(&base_url, true, &echo_hi());
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hi");
    assert!(
        stderr_of(&output).is_empty(),
        "gate disabled must be silent"
    );
    let seen = recorded.lock().unwrap();
    assert_eq!(seen.len(), 1, "exactly one acquire, no release");
    let body: serde_json::Value = serde_json::from_str(&seen[0].1).unwrap();
    assert_eq!(body["sessionId"], "session-test");
    assert_eq!(body["wait"], true);
    assert!(body["cmd"].as_str().unwrap().contains("echo"));
}

#[test]
fn heavy_queued_then_granted_prints_position_and_releases_with_exit_code() {
    let (base_url, recorded) = spawn_gate(vec![
        (
            "/api/heavy-jobs/acquire",
            r#"{"outcome":"queued","position":1,"total":1}"#,
        ),
        (
            "/api/heavy-jobs/acquire",
            r#"{"outcome":"granted","leaseId":"L1","sessionId":"session-test","target":"local","forced":false}"#,
        ),
    ]);
    let output = run_with_gate(&base_url, true, &exit_with_7());
    assert_eq!(output.status.code(), Some(7));
    let stderr = stderr_of(&output);
    assert!(stderr.contains("排队中 1/1"), "stderr: {stderr}");
    assert!(stderr.contains("已拿到槽位"), "stderr: {stderr}");

    let seen = recorded.lock().unwrap();
    let paths: Vec<&str> = seen.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/api/heavy-jobs/acquire",
            "/api/heavy-jobs/acquire",
            "/api/heavy-jobs/release"
        ]
    );
    let release: serde_json::Value = serde_json::from_str(&seen[2].1).unwrap();
    assert_eq!(release["leaseId"], "L1");
    assert_eq!(release["exitCode"], 7);
    assert!(release["durationMs"].is_number());
}
