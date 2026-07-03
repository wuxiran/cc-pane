use std::io;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// 本地 Git 命令超时（30 秒）
pub const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(30);

/// 网络 Git 命令超时（120 秒）
pub const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

/// Git checkout 操作超时（60 秒）— worktree add 等涉及文件写入的操作
pub const GIT_CHECKOUT_TIMEOUT: Duration = Duration::from_secs(60);

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
pub fn git_https_credential_env(url: &str, user: &str, pass: &str) -> Vec<(String, String)> {
    use base64::Engine;
    if !url.starts_with("https://") || user.is_empty() || pass.is_empty() {
        return Vec::new();
    }
    let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
    vec![
        ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
        (
            "GIT_CONFIG_KEY_0".to_string(),
            "http.extraHeader".to_string(),
        ),
        (
            "GIT_CONFIG_VALUE_0".to_string(),
            format!("Authorization: Basic {token}"),
        ),
    ]
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

    let start = Instant::now();
    loop {
        match child.try_wait()? {
            Some(_) => return child.wait_with_output(),
            None if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("Command timed out (waited {} seconds)", timeout.as_secs()),
                ));
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_env_uses_basic_auth_header_not_url() {
        let env = git_https_credential_env("https://github.com/o/r.git", "user", "pat");
        assert_eq!(env.len(), 3);
        assert_eq!(env[0], ("GIT_CONFIG_COUNT".into(), "1".into()));
        assert_eq!(
            env[1],
            ("GIT_CONFIG_KEY_0".into(), "http.extraHeader".into())
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
    fn credential_env_empty_for_http_or_missing_creds() {
        assert!(git_https_credential_env("http://host/r.git", "u", "p").is_empty());
        assert!(git_https_credential_env("https://host/r.git", "", "p").is_empty());
        assert!(git_https_credential_env("https://host/r.git", "u", "").is_empty());
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
