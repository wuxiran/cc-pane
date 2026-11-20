//! 在 SSH 机器上跑 ACP agent：ACP 本身就是 stdio 上的 JSON-RPC，所以只要把
//! `<engine> <args>` 换成 `ssh -T host '<cd 远端目录 && exec engine args>'`，
//! 管道两端完全不变。
//!
//! 只依赖系统 `ssh`（密钥认证、BatchMode），不经 libssh2：会话要长连、要把
//! 进程树交给 ProcessGuard 管，系统 ssh 最直接。代理/跳板机器暂不支持（系统
//! ssh 不带我们的代理配置，静默直连会绕过代理）。
//!
//! 远端会话的边界：客户端文件读写、终端、MCP 注入、检查点/运行记录、撤销编辑
//! 都只对本机路径成立，远端一律关闭——agent 在对方机器上用它自己的工具干活。

use cc_panes_core::models::ssh_machine::{AuthMethod, SshMachine};
use std::time::Duration;

const CWD_PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// 一次远端会话的目标。
#[derive(Debug, Clone)]
pub struct AcpRemoteTarget {
    pub machine_id: String,
    pub machine_name: String,
    /// 远端系统：`windows` 走 `cmd /c`，其余按 POSIX 登录 shell。
    pub windows: bool,
    /// `ssh` 的连接参数（不含远端命令）。
    pub ssh_args: Vec<String>,
}

/// 机器能不能用于远端会话；不能时给出可读原因。
pub fn remote_target(machine: &SshMachine, os: Option<&str>) -> Result<AcpRemoteTarget, String> {
    if machine.uses_routed_connection() {
        return Err(format!(
            "{} uses a proxy or jump host; remote Agent Chat does not support routed machines yet",
            machine.name
        ));
    }
    if machine.auth_method == AuthMethod::Password {
        return Err(format!(
            "{} uses password authentication; remote Agent Chat needs key authentication",
            machine.name
        ));
    }
    let mut ssh_args = vec![
        "-T".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=30".to_string(),
        "-p".to_string(),
        machine.port.to_string(),
    ];
    if let Some(identity) = machine
        .identity_file
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        ssh_args.push("-i".to_string());
        ssh_args.push(expand_home(identity));
    }
    ssh_args.push(
        match machine.user.as_deref().filter(|user| !user.is_empty()) {
            Some(user) => format!("{user}@{}", machine.host),
            None => machine.host.clone(),
        },
    );
    Ok(AcpRemoteTarget {
        machine_id: machine.id.clone(),
        machine_name: machine.name.clone(),
        windows: os.is_some_and(|os| os.eq_ignore_ascii_case("windows")),
        ssh_args,
    })
}

fn expand_home(path: &str) -> String {
    match (path.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => path.to_string(),
    }
}

/// POSIX 单引号转义。
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// `~` / `~/x` 要在远端展开，其他原样加引号。
fn posix_cwd_expr(cwd: &str) -> String {
    let cwd = cwd.trim();
    if cwd.is_empty() || cwd == "~" {
        "\"$HOME\"".to_string()
    } else if let Some(rest) = cwd.strip_prefix("~/") {
        format!("\"$HOME\"/{}", sh_quote(rest))
    } else {
        sh_quote(cwd)
    }
}

/// 用登录 shell 包一层：nvm / asdf 装的 CLI 只在登录 shell 的 PATH 里。
fn posix_login(inner: &str) -> String {
    format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", sh_quote(inner))
}

fn windows_cwd_expr(cwd: &str) -> String {
    let cwd = cwd.trim();
    if cwd.is_empty() || cwd == "~" {
        "%USERPROFILE%".to_string()
    } else if let Some(rest) = cwd.strip_prefix("~/").or_else(|| cwd.strip_prefix("~\\")) {
        format!("%USERPROFILE%\\{}", rest.replace('/', "\\"))
    } else {
        cwd.to_string()
    }
}

fn windows_arg(value: &str) -> String {
    if value.is_empty() || value.contains([' ', '\t', '&', '|', '<', '>', '^']) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

/// `cmd /c` 在 cmd 与 PowerShell 两种默认 shell 下都能跑。
fn windows_cmd(inner: &str) -> String {
    format!("cmd /d /s /c \"{inner}\"")
}

/// 远端：进目录并打印绝对路径（ACP 的 session/new 要求绝对 cwd，顺带校验目录存在）。
pub fn cwd_probe_script(target: &AcpRemoteTarget, cwd: &str) -> String {
    if target.windows {
        windows_cmd(&format!("cd /d {} && cd", windows_cwd_expr(cwd)))
    } else {
        posix_login(&format!("cd {} && pwd", posix_cwd_expr(cwd)))
    }
}

/// 远端：进目录后以 exec 启动 agent（stdin/stdout 直通 ssh）。
pub fn launch_script(
    target: &AcpRemoteTarget,
    absolute_cwd: &str,
    executable: &str,
    args: &[String],
) -> String {
    if target.windows {
        let mut parts = vec![windows_arg(executable)];
        parts.extend(args.iter().map(|arg| windows_arg(arg)));
        windows_cmd(&format!(
            "cd /d {} && {}",
            windows_arg(absolute_cwd),
            parts.join(" ")
        ))
    } else {
        let mut parts = vec![sh_quote(executable)];
        parts.extend(args.iter().map(|arg| sh_quote(arg)));
        posix_login(&format!(
            "cd {} && exec {}",
            sh_quote(absolute_cwd),
            parts.join(" ")
        ))
    }
}

/// 在远端解析出绝对工作目录；目录不存在或连不上时报错（不让 agent 跑在错误目录）。
pub async fn resolve_remote_cwd(target: &AcpRemoteTarget, cwd: &str) -> Result<String, String> {
    let mut command = cc_panes_core::utils::no_window_tokio_command("ssh");
    command
        .args(&target.ssh_args)
        .arg(cwd_probe_script(target, cwd))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(CWD_PROBE_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("Timed out connecting to {}", target.machine_name))?
        .map_err(|error| format!("Unable to run ssh: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let path = stdout
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string();
    if !output.status.success() || path.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr
            .lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
            .unwrap_or("no output");
        return Err(format!(
            "Remote directory '{}' on {} is not usable: {reason}",
            cwd, target.machine_name
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(auth: AuthMethod) -> SshMachine {
        SshMachine {
            id: "m1".into(),
            name: "box".into(),
            host: "192.168.2.9".into(),
            port: 2222,
            user: Some("a".into()),
            auth_method: auth,
            identity_file: Some("/keys/id_rsa".into()),
            description: None,
            default_path: None,
            tags: vec![],
            proxy: None,
            jump_host: None,
            has_stored_password: false,
            has_stored_proxy_password: false,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn ssh_args_carry_port_identity_and_user() {
        let target = remote_target(&machine(AuthMethod::Key), Some("linux")).unwrap();
        assert!(!target.windows);
        let tail: Vec<&str> = target
            .ssh_args
            .iter()
            .rev()
            .take(4)
            .rev()
            .map(String::as_str)
            .collect();
        assert_eq!(tail, ["2222", "-i", "/keys/id_rsa", "a@192.168.2.9"]);
        assert!(target.ssh_args.contains(&"BatchMode=yes".to_string()));
    }

    #[test]
    fn password_and_routed_machines_are_rejected() {
        assert!(remote_target(&machine(AuthMethod::Password), None).is_err());
    }

    #[test]
    fn posix_scripts_quote_and_expand_home() {
        let target = remote_target(&machine(AuthMethod::Key), Some("linux")).unwrap();
        assert_eq!(
            cwd_probe_script(&target, "~"),
            r#"exec "${SHELL:-/bin/sh}" -lc 'cd "$HOME" && pwd'"#
        );
        assert_eq!(
            cwd_probe_script(&target, "~/my dir"),
            r#"exec "${SHELL:-/bin/sh}" -lc 'cd "$HOME"/'\''my dir'\'' && pwd'"#
        );
        let launch = launch_script(
            &target,
            "/home/a/it's",
            "npx",
            &["-y".into(), "pi-acp@0.0.33".into()],
        );
        assert_eq!(
            launch,
            r#"exec "${SHELL:-/bin/sh}" -lc 'cd '\''/home/a/it'\''\'\'''\''s'\'' && exec '\''npx'\'' '\''-y'\'' '\''pi-acp@0.0.33'\'''"#
        );
    }

    #[test]
    fn windows_scripts_use_cmd() {
        let target = remote_target(&machine(AuthMethod::Key), Some("Windows")).unwrap();
        assert!(target.windows);
        assert_eq!(
            cwd_probe_script(&target, "~"),
            r#"cmd /d /s /c "cd /d %USERPROFILE% && cd""#
        );
        assert_eq!(
            launch_script(&target, r"C:\Users\a\my work", "claude-code-acp", &[]),
            r#"cmd /d /s /c "cd /d "C:\Users\a\my work" && claude-code-acp""#
        );
    }
}
