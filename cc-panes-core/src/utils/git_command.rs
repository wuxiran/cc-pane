use super::error::AppError;
use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

/// 本地 Git 命令超时（30 秒）
pub const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(30);

/// 网络 Git 命令超时（120 秒）
pub const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

/// Git checkout 操作超时（60 秒）— worktree add 等涉及文件写入的操作
pub const GIT_CHECKOUT_TIMEOUT: Duration = Duration::from_secs(60);

/// 单个 Git 子进程允许返回的 stdout + stderr 总量。
pub const GIT_MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

/// 为 HTTPS Git 操作生成认证环境变量（凭证不进 URL、不进命令行）。
///
/// 安全要点：凭证经 `Authorization: Basic` header 通过 git 的 `GIT_CONFIG_*`
/// 环境变量（git ≥ 2.31）注入 `http.extraHeader`，而**不是**拼进
/// `https://user:pass@host` 形式的 URL。后者会被 git 永久写入克隆仓库的
/// `.git/config`（`remote.origin.url`），明文口令长期留在磁盘上，且每次
/// fetch/push 都复用——这是一个 HIGH 级凭证泄露风险。
///
/// 环境变量相比命令行参数（`ps`/任务管理器/审计日志可见）暴露面也更小。
/// 仅 https 场景返回非空；http 明文传输不注入，避免凭证走裸 HTTP。
///
/// header 以 `http.https://<host>/.extraHeader` 形式限定到目标主机——
/// 未限定的 `http.extraHeader` 会随该次 git 进程的所有 HTTP 请求发送，
/// 跨主机 302 重定向（企业 Git → CDN/镜像）时凭证会泄漏给第三方主机。
pub fn git_https_credential_env(url: &str, user: &str, pass: &str) -> Vec<(String, String)> {
    use base64::Engine;
    if user.is_empty() || pass.is_empty() {
        return Vec::new();
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return Vec::new();
    };
    if parsed.scheme() != "https" {
        return Vec::new();
    }
    let Some(host) = parsed.host_str() else {
        return Vec::new();
    };
    let host_with_port = match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
    vec![
        ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
        (
            "GIT_CONFIG_KEY_0".to_string(),
            format!("http.https://{host_with_port}/.extraHeader"),
        ),
        (
            "GIT_CONFIG_VALUE_0".to_string(),
            format!("Authorization: Basic {token}"),
        ),
    ]
}

/// 为 git clone 准备（干净 URL, 认证环境变量）。
///
/// 统一处理两种凭证来源：显式的 username/password 字段，以及用户直接粘贴的
/// `https://user:pass@host/repo.git` 内嵌形式。内嵌凭证会被剥离并转入
/// `Authorization` header——否则 git 会把带口令的 URL 原样写进克隆仓库的
/// `.git/config`（`remote.origin.url`），明文长期落盘。显式字段优先于内嵌。
///
/// 凭证 + 非 https 协议直接报错（而不是静默丢弃凭证后让 git 以晦涩的
/// "could not read Username" 失败）。
pub fn prepare_git_clone_auth(
    url: &str,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<(String, Vec<(String, String)>), AppError> {
    let mut parsed =
        url::Url::parse(url).map_err(|e| AppError::from(format!("Invalid Git URL: {e}")))?;

    let decode = |s: &str| {
        urlencoding::decode(s)
            .map(|c| c.into_owned())
            .unwrap_or_else(|_| s.to_string())
    };
    let embedded_user = (!parsed.username().is_empty()).then(|| decode(parsed.username()));
    let embedded_pass = parsed.password().map(decode);
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    let clean_url = parsed.to_string();

    let user = username
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or(embedded_user);
    let pass = password
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or(embedded_pass);
    let (Some(user), Some(pass)) = (user, pass) else {
        return Ok((clean_url, Vec::new()));
    };

    if parsed.scheme() != "https" {
        return Err(AppError::from(
            "Git credentials are only supported for HTTPS URLs (plain HTTP would send them in cleartext)"
                .to_string(),
        ));
    }
    let env = git_https_credential_env(&clean_url, &user, &pass);
    Ok((clean_url, env))
}

/// 把 URL 里可能内嵌的 `user:pass@` 凭证脱敏后再进日志。
pub fn redact_git_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    match rest.split_once('@') {
        Some((_creds, host)) => format!("{scheme}://***@{host}"),
        None => url.to_string(),
    }
}

/// 带超时的命令执行，替代 `Command::output()`
///
/// 通过 `try_wait` 轮询实现超时检测，超时后 kill 子进程。
/// Windows 上自动设置 `CREATE_NO_WINDOW` 防止弹出控制台窗口。
pub fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> io::Result<Output> {
    output_with_timeout_limit(cmd, timeout, GIT_MAX_OUTPUT_BYTES)
}

/// 带超时和硬输出上限执行命令。
///
/// stdout/stderr 必须在子进程运行期间并发排空，否则任一 pipe 写满后子进程会阻塞，
/// `try_wait` 会把正常的大输出命令误判为超时。
pub fn output_with_timeout_limit(
    cmd: &mut Command,
    timeout: Duration,
    max_output_bytes: usize,
) -> io::Result<Output> {
    // 阻止 git 弹出交互式认证提示（GUI 子进程中无法交互）
    cmd.env("GIT_TERMINAL_PROMPT", "0");

    // Windows: 不创建控制台窗口
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("failed to capture command stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("failed to capture command stderr"))?;
    let total_bytes = Arc::new(AtomicUsize::new(0));
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout_thread = spawn_limited_reader(
        stdout,
        total_bytes.clone(),
        exceeded.clone(),
        max_output_bytes,
    );
    let stderr_thread =
        spawn_limited_reader(stderr, total_bytes, exceeded.clone(), max_output_bytes);

    let start = Instant::now();
    let wait_result = loop {
        if exceeded.load(Ordering::Acquire) {
            let _ = child.kill();
            break Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                format!("Command output limit exceeded ({max_output_bytes} bytes)"),
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                break Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("Command timed out (waited {} seconds)", timeout.as_secs()),
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                break Err(error);
            }
        }
    };

    if wait_result.is_err() {
        let _ = child.wait();
    }
    let stdout_result = join_reader(stdout_thread);
    let stderr_result = join_reader(stderr_thread);
    let stdout = stdout_result?;
    let stderr = stderr_result?;
    if exceeded.load(Ordering::Acquire) {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            format!("Command output limit exceeded ({max_output_bytes} bytes)"),
        ));
    }

    wait_result.map(|status| Output {
        status,
        stdout,
        stderr,
    })
}

fn spawn_limited_reader<R>(
    mut reader: R,
    total_bytes: Arc<AtomicUsize>,
    exceeded: Arc<AtomicBool>,
    max_output_bytes: usize,
) -> std::thread::JoinHandle<io::Result<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            let previous = total_bytes.fetch_add(read, Ordering::AcqRel);
            let remaining = max_output_bytes.saturating_sub(previous);
            output.extend_from_slice(&chunk[..read.min(remaining)]);
            if read > remaining {
                exceeded.store(true, Ordering::Release);
            }
        }
        Ok(output)
    })
}

fn join_reader(handle: std::thread::JoinHandle<io::Result<Vec<u8>>>) -> io::Result<Vec<u8>> {
    handle
        .join()
        .map_err(|_| io::Error::other("command output reader thread panicked"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_env_uses_host_scoped_basic_auth_header_not_url() {
        let env = git_https_credential_env("https://github.com/o/r.git", "user", "pat");
        assert_eq!(env.len(), 3);
        assert_eq!(env[0], ("GIT_CONFIG_COUNT".into(), "1".into()));
        // host 限定：跨主机 redirect 时不外发（对比裸 http.extraHeader）
        assert_eq!(
            env[1],
            (
                "GIT_CONFIG_KEY_0".into(),
                "http.https://github.com/.extraHeader".into()
            )
        );
        // base64("user:pat") = dXNlcjpwYXQ=
        assert_eq!(
            env[2],
            (
                "GIT_CONFIG_VALUE_0".into(),
                "Authorization: Basic dXNlcjpwYXQ=".into()
            )
        );
    }

    #[test]
    fn credential_env_keeps_non_default_port_in_scope() {
        let env = git_https_credential_env("https://git.corp.example:8443/o/r.git", "u", "p");
        assert_eq!(
            env[1],
            (
                "GIT_CONFIG_KEY_0".into(),
                "http.https://git.corp.example:8443/.extraHeader".into()
            )
        );
    }

    #[test]
    fn credential_env_empty_for_http_or_missing_creds() {
        assert!(git_https_credential_env("http://host/r.git", "u", "p").is_empty());
        assert!(git_https_credential_env("https://host/r.git", "", "p").is_empty());
        assert!(git_https_credential_env("https://host/r.git", "u", "").is_empty());
    }

    #[test]
    fn prepare_auth_strips_embedded_userinfo_into_header() {
        let (clean_url, env) =
            prepare_git_clone_auth("https://user:s%40cret@github.com/o/r.git", None, None).unwrap();
        // URL 里的凭证被剥离，git 不会把口令写进 .git/config
        assert_eq!(clean_url, "https://github.com/o/r.git");
        assert_eq!(env.len(), 3);
        // percent-encoded 的口令解码后再进 Basic token: base64("user:s@cret")
        use base64::Engine;
        let expected = base64::engine::general_purpose::STANDARD.encode("user:s@cret".as_bytes());
        assert_eq!(env[2].1, format!("Authorization: Basic {expected}"));
    }

    #[test]
    fn prepare_auth_explicit_fields_win_over_embedded() {
        let (clean_url, env) = prepare_git_clone_auth(
            "https://old:old@github.com/o/r.git",
            Some("newuser"),
            Some("newpass"),
        )
        .unwrap();
        assert_eq!(clean_url, "https://github.com/o/r.git");
        use base64::Engine;
        let expected = base64::engine::general_purpose::STANDARD.encode("newuser:newpass");
        assert_eq!(env[2].1, format!("Authorization: Basic {expected}"));
    }

    #[test]
    fn prepare_auth_no_credentials_passes_url_through() {
        let (clean_url, env) =
            prepare_git_clone_auth("https://github.com/o/r.git", None, None).unwrap();
        assert_eq!(clean_url, "https://github.com/o/r.git");
        assert!(env.is_empty());
        // 空字符串字段视同未提供
        let (_, env) =
            prepare_git_clone_auth("https://github.com/o/r.git", Some(""), Some("")).unwrap();
        assert!(env.is_empty());
    }

    #[test]
    fn prepare_auth_rejects_credentials_over_plain_http() {
        assert!(prepare_git_clone_auth("http://host/r.git", Some("u"), Some("p")).is_err());
        assert!(prepare_git_clone_auth("http://u:p@host/r.git", None, None).is_err());
        // 无凭证的 http 仍放行（validate_git_url 允许 http）
        assert!(prepare_git_clone_auth("http://host/r.git", None, None).is_ok());
    }

    #[test]
    fn redact_git_url_masks_embedded_credentials() {
        assert_eq!(
            redact_git_url("https://user:token@github.com/o/r.git"),
            "https://***@github.com/o/r.git"
        );
        assert_eq!(
            redact_git_url("https://github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
    }

    #[test]
    fn test_output_with_timeout_success() {
        let output =
            output_with_timeout(Command::new("git").arg("--version"), Duration::from_secs(5));
        assert!(output.is_ok());
        let out = output.unwrap();
        assert!(out.status.success());
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("git version"));
    }

    #[test]
    fn output_with_timeout_drains_output_larger_than_pipe_capacity() {
        let temp = tempfile::tempdir().unwrap();
        let blob = temp.path().join("blob.bin");
        std::fs::write(&blob, vec![b'x'; 256 * 1024]).unwrap();

        let init = Command::new("git")
            .args(["init", "-q"])
            .current_dir(temp.path())
            .status()
            .unwrap();
        assert!(init.success());
        let hash = Command::new("git")
            .args(["hash-object", "-w"])
            .arg(&blob)
            .current_dir(temp.path())
            .output()
            .unwrap();
        assert!(hash.status.success());
        let hash = String::from_utf8(hash.stdout).unwrap();

        let output = output_with_timeout_limit(
            Command::new("git")
                .args(["cat-file", "blob", hash.trim()])
                .current_dir(temp.path()),
            Duration::from_secs(5),
            512 * 1024,
        )
        .unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 256 * 1024);
    }

    #[test]
    fn output_with_timeout_kills_command_when_combined_output_exceeds_limit() {
        let result = output_with_timeout_limit(
            Command::new("git").arg("--version"),
            Duration::from_secs(5),
            4,
        );

        let error = result.expect_err("output above the hard limit must fail");
        assert_eq!(error.kind(), io::ErrorKind::FileTooLarge);
        assert!(error.to_string().contains("output limit"));
    }

    #[cfg(not(windows))]
    #[test]
    fn test_output_with_timeout_expires() {
        let result = output_with_timeout(Command::new("sleep").arg("10"), Duration::from_secs(1));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    #[cfg(windows)]
    #[test]
    fn test_output_with_timeout_expires() {
        let result = output_with_timeout(
            Command::new("ping").args(["-n", "10", "127.0.0.1"]),
            Duration::from_secs(1),
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }
}
