//! `cc-panes-ctl run [--heavy] [--label L] -- <cmd…>`：agent 侧跑重命令的唯一入口（docs/107 P6）。
//!
//! 行为：
//! - 无 `--heavy` → 原样 spawn，透传退出码，零网络。
//! - `--heavy` → 用 `CC_PANES_API_BASE_URL/PORT/TOKEN`（WSL 内也可达）或数据目录 manifest 找
//!   orchestrator，`POST /api/heavy-jobs/acquire` 长轮询拿槽；位次变化时向 **stderr** 打一行
//!   `[cc-panes] 排队中 n/m`（不进 stdout，不污染命令输出）。门禁关 / 不可达 / 无会话 id → 直接跑。
//! - 拿到槽后：子进程继承 stdio，后台线程每 20 s 心跳，退出后 `release` 并以子进程退出码退出。
//!
//! Ctrl-C：不自己杀子进程。同一控制台 / 前台进程组里子进程本来就会收到 Ctrl-C（Windows 的
//! `GenerateConsoleCtrlEvent` 是整组的），ctl 只需**吞掉**自己这份、等子进程退出、归还槽位，
//! 再带着它的退出码退出。自己动手 kill 反而会和子进程自己的清理打架。
//!
//! Windows 的程序名解析：`Command::new("npm")` 只会找 `npm.exe`，而 npm / npx / pnpm / tsc /
//! vitest 这些全是 `.cmd` 垫片，直接 spawn 会报"找不到文件"。所以 bare 名先按
//! `PATH` × `PATHEXT` 解析（[`resolve_program`]）；解析到 `.cmd` / `.bat` 时经
//! `cmd.exe /d /s /c "<path> args…"` 起（批处理只能由 cmd.exe 解释），其余可执行文件
//! 仍直接 spawn，不过 shell。参数按 MSVCRT 规则引用（[`quote_windows_arg`]），带空格 /
//! 引号 / cmd 元字符的参数原样到达垫片后面的 node.exe。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::cli::CliExit;
use crate::commands::CommandContext;
use crate::discovery::{
    data_dir_candidates, discover_orchestrator_endpoint, env_orchestrator_endpoint,
};

/// 会话 id 注入变量（由 CC-Panes 启动会话时写入环境）。
pub const SESSION_ENV: &str = "CC_PANES_PTY_SESSION_ID";
/// 与 orchestrator 的 `LONG_POLL_MAX`（25 s）留 10 s 余量。
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(35);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
/// 服务端若不长轮询（旧版 / 异常）而立刻返回 Queued，避免打爆它。
const QUEUED_RETRY_BACKOFF: Duration = Duration::from_millis(500);
const EXIT_SPAWN_FAILED: i32 = 127;

pub(crate) fn run(
    context: &CommandContext,
    heavy: bool,
    label: Option<&str>,
    cmd: &[String],
) -> Result<(), CliExit> {
    let Some(program) = cmd.first() else {
        return Err(CliExit::argument(
            "run 需要在 `--` 之后给出要执行的命令，例如 `cc-panes-ctl run --heavy -- cargo check`",
        ));
    };

    let lease = if heavy {
        GateClient::discover(context).and_then(|client| client.acquire_blocking(cmd, label))
    } else {
        None
    };

    swallow_ctrl_c();
    let started = Instant::now();
    let status = build_command(program, &cmd[1..]).status();
    let code = match status {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            if let Some(lease) = lease {
                lease.release(Some(EXIT_SPAWN_FAILED), started.elapsed());
            }
            return Err(CliExit {
                code: EXIT_SPAWN_FAILED,
                message: format!("无法启动 `{program}`: {error}"),
            });
        }
    };
    if let Some(lease) = lease {
        lease.release(Some(code), started.elapsed());
    }
    if code == 0 {
        Ok(())
    } else {
        Err(CliExit::silent(code))
    }
}

/// 组装子进程命令。非 Windows：原样 `Command::new(program)`。
/// Windows：解析不到就仍交给 `Command::new`（让它报原生错误）。
fn build_command(program: &str, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        let path = std::env::var("PATH").unwrap_or_default();
        let pathext = std::env::var("PATHEXT").unwrap_or_default();
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        if let Some(resolved) = resolve_program(program, &path, &pathext, &cwd) {
            return command_for_resolved(&resolved, args);
        }
    }
    let mut command = Command::new(program);
    command.args(args);
    command
}

/// 解析后的程序怎么起：批处理经 `cmd.exe /d /s /c`，其余直接 spawn（无 shell）。
#[cfg_attr(not(windows), allow(dead_code))]
fn command_for_resolved(resolved: &Path, args: &[String]) -> Command {
    if is_batch_file(resolved) {
        let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut command = Command::new(comspec);
        command.arg("/d").arg("/s").arg("/c");
        // `/s`：去掉整段的首尾引号后原样当命令行；所以整段必须自己包一层引号。
        let line = format!("\"{}\"", cmd_exe_line(resolved, args));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.raw_arg(line);
        }
        #[cfg(not(windows))]
        {
            command.arg(line);
        }
        return command;
    }
    let mut command = Command::new(resolved);
    command.args(args);
    command
}

/// 默认 `PATHEXT`（环境里没有时用，顺序照 Windows 默认）。
#[cfg_attr(not(windows), allow(dead_code))]
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// 按 `PATH` × `PATHEXT` 解析程序名。带路径分隔符的名字只在原地找（补扩展名）；
/// bare 名先看当前目录再看 `PATH` 各目录（与 cmd.exe / `CreateProcess` 一致）。
/// 每个目录内：名字本身带扩展名就先按原样找，再按 `PATHEXT` 顺序补。
#[cfg_attr(not(windows), allow(dead_code))]
fn resolve_program(program: &str, path: &str, pathext: &str, cwd: &Path) -> Option<PathBuf> {
    let program = program.trim();
    if program.is_empty() {
        return None;
    }
    let exts: Vec<String> = {
        let raw = if pathext.trim().is_empty() {
            DEFAULT_PATHEXT
        } else {
            pathext
        };
        raw.split(';')
            .map(str::trim)
            .filter(|ext| !ext.is_empty())
            .map(|ext| ext.to_string())
            .collect()
    };
    let has_separator = program.contains(['/', '\\']);
    let candidate_in = |dir: &Path| -> Option<PathBuf> {
        let base = dir.join(program);
        if Path::new(program).extension().is_some() && base.is_file() {
            return Some(base);
        }
        for ext in &exts {
            let mut name = program.to_string();
            // 小写补扩展名：NTFS 不分大小写，但日志 / 测试里 `npm.cmd` 比 `npm.CMD` 好认。
            name.push_str(&ext.to_ascii_lowercase());
            let candidate = dir.join(&name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    };
    if has_separator {
        let direct = Path::new(program);
        let dir = if direct.is_absolute() {
            PathBuf::new()
        } else {
            cwd.to_path_buf()
        };
        return candidate_in(&dir);
    }
    if let Some(found) = candidate_in(cwd) {
        return Some(found);
    }
    path.split(';')
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(|dir| dir.trim_matches('"'))
        .find_map(|dir| candidate_in(Path::new(dir)))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_batch_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// `cmd.exe /c` 后面那一段（不含外层引号）：`"<path>" arg1 "arg 2" …`。
#[cfg_attr(not(windows), allow(dead_code))]
fn cmd_exe_line(program: &Path, args: &[String]) -> String {
    let mut line = quote_windows_arg(&program.to_string_lossy(), true);
    for arg in args {
        line.push(' ');
        line.push_str(&quote_windows_arg(arg, true));
    }
    line
}

/// MSVCRT 参数引用：有空白 / 引号 / 为空才加引号；引号前的反斜杠成双，引号写成 `\"`。
/// `for_cmd` 时含 cmd 元字符（`& | < > ^ ( ) % !`）的也加引号——cmd.exe 在双引号内
/// 不解释它们（`%` 展开除外，那是 cmd 的固有行为）。
#[cfg_attr(not(windows), allow(dead_code))]
fn quote_windows_arg(arg: &str, for_cmd: bool) -> String {
    let needs_quotes = arg.is_empty()
        || arg.chars().any(|c| {
            matches!(c, ' ' | '\t' | '\n' | '"')
                || (for_cmd && matches!(c, '&' | '|' | '<' | '>' | '^' | '(' | ')' | '%' | '!'))
        });
    if !needs_quotes {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            other => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                backslashes = 0;
                out.push(other);
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// ctl 自己忽略 Ctrl-C（子进程照常收到），保证能走到 release。只装一次；失败不致命。
fn swallow_ctrl_c() {
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = ctrlc::set_handler(|| {});
}

fn note(message: &str) {
    let stderr = std::io::stderr();
    let mut handle = stderr.lock();
    let _ = writeln!(handle, "[cc-panes] {message}");
    let _ = handle.flush();
}

#[derive(Debug, Clone)]
struct GateClient {
    base_url: String,
    token: String,
}

#[derive(Debug)]
enum AcquireReply {
    Granted { lease_id: String, forced: bool },
    Queued { position: u64, total: u64 },
    Passthrough(String),
    Unreachable(String),
}

impl GateClient {
    /// env（会话内注入，WSL 内已做主机重写）优先；否则按数据目录 manifest 找。都没有 → None。
    fn discover(context: &CommandContext) -> Option<Self> {
        if let Some((base_url, token)) = env_orchestrator_endpoint() {
            return Some(Self { base_url, token });
        }
        let candidates = data_dir_candidates(&context.mode).ok()?;
        candidates
            .iter()
            .find_map(|candidate| discover_orchestrator_endpoint(&candidate.path).ok())
            .map(|endpoint| Self {
                base_url: endpoint.base_url,
                token: endpoint.token,
            })
    }

    fn post(&self, path: &str, body: &Value, timeout: Duration) -> Result<Value, String> {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .build()
            .new_agent();
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let payload = serde_json::to_vec(body).map_err(|error| error.to_string())?;
        let mut response = agent
            .post(&url)
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("Content-Type", "application/json")
            .send(payload.as_slice())
            .map_err(|error| format!("{error}"))?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .read_to_string()
            .map_err(|error| error.to_string())?;
        if !(200..300).contains(&status) {
            return Err(format!("HTTP {status}"));
        }
        serde_json::from_str(&text).map_err(|error| format!("响应不是 JSON: {error}"))
    }

    fn acquire(&self, session_id: &str, cmd: &[String], label: Option<&str>) -> AcquireReply {
        let mut body = json!({
            "sessionId": session_id,
            "cmd": cmd.join(" "),
            "wait": true,
        });
        if let Some(label) = label {
            body["label"] = Value::String(label.to_string());
        }
        match self.post("/api/heavy-jobs/acquire", &body, ACQUIRE_TIMEOUT) {
            Err(error) => AcquireReply::Unreachable(error),
            Ok(value) => parse_acquire_reply(&value),
        }
    }

    /// 轮询直到拿槽或判定透传。返回 Some = 持有租约（已起心跳线程）。
    fn acquire_blocking(self, cmd: &[String], label: Option<&str>) -> Option<HeldLease> {
        let session_id = std::env::var(SESSION_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let Some(session_id) = session_id else {
            note(&format!("缺少 {SESSION_ENV}，不经门禁直接执行"));
            return None;
        };
        let mut last_position: Option<(u64, u64)> = None;
        loop {
            match self.acquire(&session_id, cmd, label) {
                AcquireReply::Granted { lease_id, forced } => {
                    if forced {
                        note("排队超时，门禁强制放行");
                    } else if last_position.is_some() {
                        note("已拿到槽位，开始执行");
                    }
                    return Some(HeldLease::start(self, lease_id));
                }
                AcquireReply::Queued { position, total } => {
                    if last_position != Some((position, total)) {
                        note(&format!("排队中 {position}/{total}"));
                        last_position = Some((position, total));
                    }
                    thread::sleep(QUEUED_RETRY_BACKOFF);
                }
                AcquireReply::Passthrough(reason) => {
                    if reason != "gate disabled" {
                        note(&format!("门禁透传：{reason}"));
                    }
                    return None;
                }
                AcquireReply::Unreachable(error) => {
                    note(&format!("门禁不可达（{error}），直接执行"));
                    return None;
                }
            }
        }
    }
}

fn parse_acquire_reply(value: &Value) -> AcquireReply {
    match value.get("outcome").and_then(Value::as_str) {
        Some("granted") => match value.get("leaseId").and_then(Value::as_str) {
            Some(lease_id) => AcquireReply::Granted {
                lease_id: lease_id.to_string(),
                forced: value
                    .get("forced")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            },
            None => AcquireReply::Unreachable("granted 响应缺少 leaseId".to_string()),
        },
        Some("queued") => AcquireReply::Queued {
            position: value.get("position").and_then(Value::as_u64).unwrap_or(0),
            total: value.get("total").and_then(Value::as_u64).unwrap_or(0),
        },
        Some("passthrough") => AcquireReply::Passthrough(
            value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
        ),
        other => AcquireReply::Unreachable(format!("未知 outcome: {other:?}")),
    }
}

struct HeldLease {
    client: GateClient,
    lease_id: String,
    stop: Arc<AtomicBool>,
    heartbeat: Option<JoinHandle<()>>,
}

impl HeldLease {
    fn start(client: GateClient, lease_id: String) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let heartbeat = {
            let client = client.clone();
            let lease_id = lease_id.clone();
            let stop = stop.clone();
            thread::spawn(move || {
                let mut last_beat = Instant::now();
                while !stop.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(250));
                    if last_beat.elapsed() < HEARTBEAT_INTERVAL {
                        continue;
                    }
                    last_beat = Instant::now();
                    let reply = client.post(
                        "/api/heavy-jobs/heartbeat",
                        &json!({ "leaseId": lease_id }),
                        CONTROL_TIMEOUT,
                    );
                    // 租约已被回收：服务端放弃了我们，继续跑但别再吵它。
                    if matches!(reply, Ok(ref value) if value.get("alive") == Some(&Value::Bool(false)))
                    {
                        break;
                    }
                }
            })
        };
        Self {
            client,
            lease_id,
            stop,
            heartbeat: Some(heartbeat),
        }
    }

    fn release(mut self, exit_code: Option<i32>, duration: Duration) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.heartbeat.take() {
            let _ = handle.join();
        }
        let _ = self.client.post(
            "/api/heavy-jobs/release",
            &json!({
                "leaseId": self.lease_id,
                "exitCode": exit_code,
                "durationMs": duration.as_millis() as u64,
            }),
            CONTROL_TIMEOUT,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_arg_quoting_follows_msvcrt_rules() {
        assert_eq!(quote_windows_arg("plain", false), "plain");
        assert_eq!(quote_windows_arg("", false), "\"\"");
        assert_eq!(quote_windows_arg("hello world", false), "\"hello world\"");
        assert_eq!(quote_windows_arg("say \"hi\"", false), "\"say \\\"hi\\\"\"");
        // 引号前的反斜杠成双；结尾反斜杠成双（否则会吃掉收尾引号）
        assert_eq!(quote_windows_arg("a\\\"b", false), "\"a\\\\\\\"b\"");
        assert_eq!(quote_windows_arg("C:\\dir\\", false), "C:\\dir\\");
        assert_eq!(
            quote_windows_arg("C:\\my dir\\", false),
            "\"C:\\my dir\\\\\""
        );
        // cmd 元字符只在 for_cmd 时加引号
        assert_eq!(quote_windows_arg("a&b", false), "a&b");
        assert_eq!(quote_windows_arg("a&b", true), "\"a&b\"");
        assert_eq!(
            quote_windows_arg("--glob=!node_modules", true),
            "\"--glob=!node_modules\""
        );
    }

    #[test]
    fn cmd_exe_line_quotes_program_and_each_arg() {
        let line = cmd_exe_line(
            Path::new("C:\\Program Files\\nodejs\\npm.cmd"),
            &["run".to_string(), "build it".to_string()],
        );
        assert_eq!(
            line,
            "\"C:\\Program Files\\nodejs\\npm.cmd\" run \"build it\""
        );
        assert!(is_batch_file(Path::new("x\\npm.cmd")));
        assert!(is_batch_file(Path::new("x\\old.BAT")));
        assert!(!is_batch_file(Path::new("x\\cargo.exe")));
        assert!(!is_batch_file(Path::new("x\\cargo")));
    }

    /// bare 名按 PATH 目录 × PATHEXT 顺序解析：`npm` → `npm.cmd`，`.exe` 优先于 `.cmd`。
    /// 只在 Windows 跑：PATHEXT 是大写而文件名小写，靠的是 NTFS 不分大小写。
    #[cfg(windows)]
    #[test]
    fn resolves_bare_names_through_path_and_pathext() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        let other = dir.path().join("other");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(bin.join("npm.cmd"), "@echo off\r\n").unwrap();
        std::fs::write(bin.join("both.cmd"), "").unwrap();
        std::fs::write(bin.join("both.exe"), "").unwrap();
        std::fs::write(other.join("later.cmd"), "").unwrap();
        std::fs::write(bin.join("noext"), "").unwrap();
        let path = format!("{};\"{}\"", bin.display(), other.display());
        let pathext = ".COM;.EXE;.BAT;.CMD";
        let cwd = dir.path();

        assert_eq!(
            resolve_program("npm", &path, pathext, cwd),
            Some(bin.join("npm.cmd"))
        );
        assert_eq!(
            resolve_program("both", &path, pathext, cwd),
            Some(bin.join("both.exe")),
            "PATHEXT order wins inside a directory"
        );
        assert_eq!(
            resolve_program("later", &path, pathext, cwd),
            Some(other.join("later.cmd")),
            "quoted PATH entries are honoured"
        );
        assert_eq!(
            resolve_program("npm.cmd", &path, pathext, cwd),
            Some(bin.join("npm.cmd")),
            "explicit extension found as-is"
        );
        assert_eq!(resolve_program("missing", &path, pathext, cwd), None);
        assert_eq!(
            resolve_program("noext", &path, pathext, cwd),
            None,
            "a file without an executable extension is not a program"
        );
        // 带路径的名字只在原地找并补扩展名
        let relative = format!("bin{}npm", std::path::MAIN_SEPARATOR);
        assert_eq!(
            resolve_program(&relative, "", pathext, cwd),
            Some(cwd.join("bin").join("npm.cmd"))
        );
        assert_eq!(
            resolve_program(&bin.join("npm").to_string_lossy(), "", pathext, cwd),
            Some(bin.join("npm.cmd"))
        );
        // 空 PATHEXT 用默认表
        assert_eq!(
            resolve_program("npm", &path, "", cwd),
            Some(bin.join("npm.cmd"))
        );
    }

    /// 真起一个 `.cmd`：退出码透传，带空格 / 引号的参数原样到达。
    #[cfg(windows)]
    #[test]
    fn runs_cmd_shim_through_cmd_exe_with_exit_code_and_args_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("echoargs.cmd");
        std::fs::write(&shim, "@echo off\r\necho ARGS=%*\r\nexit /b 7\r\n").unwrap();
        let resolved = resolve_program(
            "echoargs",
            &dir.path().to_string_lossy(),
            ".COM;.EXE;.BAT;.CMD",
            Path::new("."),
        )
        .expect("shim resolves through PATH");
        assert_eq!(resolved, shim);

        let args = vec![
            "hello world".to_string(),
            "plain".to_string(),
            "say \"hi\"".to_string(),
            "a&b".to_string(),
        ];
        let output = command_for_resolved(&resolved, &args)
            .output()
            .expect("cmd.exe spawns the shim");
        assert_eq!(
            output.status.code(),
            Some(7),
            "batch exit code is propagated"
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("ARGS=\"hello world\" plain \"say \\\"hi\\\"\" \"a&b\""),
            "stdout: {stdout:?}"
        );

        // `.exe` 不经 shell：program 就是解析到的路径本身。
        let exe = resolve_program(
            "cmd",
            &std::env::var("PATH").unwrap_or_default(),
            &std::env::var("PATHEXT").unwrap_or_default(),
            Path::new("."),
        )
        .expect("cmd.exe on PATH");
        assert!(!is_batch_file(&exe));
        let mut direct = command_for_resolved(&exe, &["/c".to_string(), "exit 3".to_string()]);
        assert_eq!(direct.get_program(), exe.as_os_str());
        assert_eq!(direct.output().unwrap().status.code(), Some(3));
    }

    #[test]
    fn parses_three_outcomes_and_rejects_garbage() {
        assert!(matches!(
            parse_acquire_reply(&json!({ "outcome": "granted", "leaseId": "L1", "forced": true })),
            AcquireReply::Granted { ref lease_id, forced: true } if lease_id == "L1"
        ));
        assert!(matches!(
            parse_acquire_reply(&json!({ "outcome": "queued", "position": 2, "total": 4 })),
            AcquireReply::Queued {
                position: 2,
                total: 4
            }
        ));
        assert!(matches!(
            parse_acquire_reply(&json!({ "outcome": "passthrough", "reason": "gate disabled" })),
            AcquireReply::Passthrough(ref reason) if reason == "gate disabled"
        ));
        assert!(matches!(
            parse_acquire_reply(&json!({ "outcome": "granted" })),
            AcquireReply::Unreachable(_)
        ));
        assert!(matches!(
            parse_acquire_reply(&json!({ "hello": 1 })),
            AcquireReply::Unreachable(_)
        ));
    }
}
