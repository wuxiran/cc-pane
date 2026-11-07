//! 把 headless cc-panes-web 部署到一台 SSH 机器（docs/111-multi-device.md）。
//!
//! 这里只放与 SSH 会话打交道的同步原语；编排（下载发布包、进度事件、
//! 部署后的 HTTP 校验）在 src-tauri 的 `device_commands` 里。
//!
//! 远端布局：
//! - `~/.cc-panes/bin/cc-panes-web`（先传到 `.new` 再 `mv`，运行中也能替换）
//! - systemd user 服务 `cc-panes-web.service`；没有 systemd 时 `nohup` + pidfile
//! - 服务只监听 127.0.0.1:<port>，`--headless` 要求设备令牌

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use ssh2::Session;

pub const REMOTE_BIN_DIR: &str = ".cc-panes/bin";
pub const REMOTE_BIN_NAME: &str = "cc-panes-web";
pub const SERVICE_NAME: &str = "cc-panes-web";
const EXEC_TIMEOUT_MS: u32 = 60_000;

#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

impl ExecOutput {
    fn ok(self, what: &str) -> Result<String> {
        if self.status != 0 {
            bail!(
                "{what} failed (exit {}): {}",
                self.status,
                self.stderr.trim().lines().last().unwrap_or_default()
            );
        }
        Ok(self.stdout)
    }
}

/// 在远端执行一条 `sh -c` 命令（非交互、无 PTY）。
pub fn remote_exec(session: &Session, command: &str) -> Result<ExecOutput> {
    session.set_blocking(true);
    session.set_timeout(EXEC_TIMEOUT_MS);
    let mut channel = session
        .channel_session()
        .context("Failed to open an SSH exec channel")?;
    channel
        .exec(command)
        .with_context(|| format!("Failed to run remote command: {command}"))?;
    let mut stdout = String::new();
    channel.read_to_string(&mut stdout).ok();
    let mut stderr = String::new();
    channel.stderr().read_to_string(&mut stderr).ok();
    channel.wait_close().ok();
    let status = channel.exit_status().unwrap_or(-1);
    session.set_timeout(0);
    Ok(ExecOutput {
        status,
        stdout,
        stderr,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePlatform {
    /// `linux` / `macos`，与 `std::env::consts::OS` 同口径
    pub os: String,
    /// `x86_64` / `aarch64`，与 `std::env::consts::ARCH` 同口径
    pub arch: String,
    pub home: String,
    pub user: String,
    /// 用户登录 shell 的交互式 PATH：服务进程据此找到 nvm / npm 全局安装的 claude
    pub login_path: Option<String>,
    pub has_systemd_user: bool,
    /// systemd linger 是否开启（关闭时用户登出后服务会被停掉）
    pub linger: Option<bool>,
    pub installed_version: Option<String>,
}

impl RemotePlatform {
    pub fn bin_dir(&self) -> String {
        format!("{}/{REMOTE_BIN_DIR}", self.home)
    }

    pub fn bin_path(&self) -> String {
        format!("{}/{REMOTE_BIN_NAME}", self.bin_dir())
    }

    /// 与发布包命名一致：`cc-panes-web_<ver>_linux-x86_64.tar.gz`
    pub fn asset_suffix(&self) -> String {
        format!("{}-{}", self.os, self.arch)
    }
}

fn normalize_os(uname_s: &str) -> String {
    match uname_s.trim().to_ascii_lowercase().as_str() {
        "darwin" => "macos".to_string(),
        other => other.to_string(),
    }
}

fn normalize_arch(uname_m: &str) -> String {
    match uname_m.trim() {
        "arm64" | "aarch64" => "aarch64".to_string(),
        "x86_64" | "amd64" => "x86_64".to_string(),
        other => other.to_string(),
    }
}

pub fn probe_platform(session: &Session) -> Result<RemotePlatform> {
    let basics = remote_exec(
        session,
        "uname -s; uname -m; printf '%s\\n' \"$HOME\"; id -un",
    )?
    .ok("Detect remote platform")?;
    let mut lines = basics.lines();
    let os = normalize_os(lines.next().unwrap_or_default());
    let arch = normalize_arch(lines.next().unwrap_or_default());
    let home = lines.next().unwrap_or_default().trim().to_string();
    let user = lines.next().unwrap_or_default().trim().to_string();
    if home.is_empty() {
        bail!("Could not determine the remote home directory");
    }

    // 交互式登录 shell 才会加载 nvm/asdf 等；限时，避免 rc 文件卡住。
    let login_path = remote_exec(
        session,
        "s=\"${SHELL:-/bin/sh}\"; (timeout 10 \"$s\" -ilc 'printf \"__CCP_PATH__%s\\n\" \"$PATH\"' 2>/dev/null || \"$s\" -lc 'printf \"__CCP_PATH__%s\\n\" \"$PATH\"') </dev/null",
    )
    .ok()
    .and_then(|out| {
        out.stdout
            .lines()
            .find_map(|line| line.strip_prefix("__CCP_PATH__").map(str::to_string))
    })
    .filter(|path| !path.trim().is_empty());

    let has_systemd_user = os == "linux"
        && remote_exec(session, "systemctl --user show-environment >/dev/null 2>&1")
            .map(|out| out.status == 0)
            .unwrap_or(false);
    let linger = if has_systemd_user {
        remote_exec(
            session,
            "loginctl show-user \"$(id -un)\" -p Linger --value 2>/dev/null",
        )
        .ok()
        .and_then(|out| match out.stdout.trim() {
            "yes" => Some(true),
            "no" => Some(false),
            _ => None,
        })
    } else {
        None
    };

    let bin = format!("{home}/{REMOTE_BIN_DIR}/{REMOTE_BIN_NAME}");
    let installed_version = remote_exec(
        session,
        &format!("{} version 2>/dev/null", shell_quote(&bin)),
    )
    .ok()
    .filter(|out| out.status == 0)
    .and_then(|out| serde_json::from_str::<serde_json::Value>(out.stdout.trim()).ok())
    .and_then(|json| {
        json.get("version")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    });

    Ok(RemotePlatform {
        os,
        arch,
        home,
        user,
        login_path,
        has_systemd_user,
        linger,
        installed_version,
    })
}

/// SFTP 上传二进制到 `~/.cc-panes/bin/cc-panes-web`（先写 `.new` 再原子替换）。
/// `local` 可以是裸二进制，也可以是发布包 `cc-panes-web_<ver>_<os>-<arch>.tar.gz`
/// （在远端用 `tar` 解开，省得本机再引入解压依赖）。
pub fn upload_binary(
    session: &Session,
    platform: &RemotePlatform,
    local: &Path,
    mut progress: impl FnMut(u64, u64),
) -> Result<()> {
    let bytes =
        std::fs::read(local).with_context(|| format!("Failed to read {}", local.display()))?;
    remote_exec(
        session,
        &format!("mkdir -p {}", shell_quote(&platform.bin_dir())),
    )?
    .ok("Create remote bin directory")?;
    session.set_blocking(true);
    let sftp = session.sftp().context("Failed to start SFTP")?;
    let staging = format!("{}.new", platform.bin_path());
    let is_archive = local
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".tar.gz"));
    let upload_path = if is_archive {
        format!("{}.tar.gz", platform.bin_path())
    } else {
        staging.clone()
    };
    let mut file = sftp
        .create(Path::new(&upload_path))
        .with_context(|| format!("Failed to create {upload_path}"))?;
    let total = bytes.len() as u64;
    let mut sent = 0_u64;
    for chunk in bytes.chunks(256 * 1024) {
        file.write_all(chunk)
            .with_context(|| format!("Failed to upload to {upload_path}"))?;
        sent += chunk.len() as u64;
        progress(sent, total);
    }
    drop(file);
    drop(sftp);
    if is_archive {
        remote_exec(
            session,
            &format!(
                "t=$(mktemp -d) && tar -xzf {archive} -C \"$t\" && mv -f \"$t\"/*/{REMOTE_BIN_NAME} {staging}; s=$?; rm -rf \"$t\" {archive}; exit $s",
                archive = shell_quote(&upload_path),
                staging = shell_quote(&staging),
            ),
        )?
        .ok("Unpack the server archive")?;
    }
    remote_exec(
        session,
        &format!(
            "chmod 755 {staging} && mv -f {staging} {bin} && {bin} version",
            staging = shell_quote(&staging),
            bin = shell_quote(&platform.bin_path()),
        ),
    )?
    .ok("Install the uploaded binary (does it match the remote OS/CPU?)")?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    /// `systemd` / `nohup`
    pub manager: String,
    pub warnings: Vec<String>,
}

fn exec_line(platform: &RemotePlatform, port: u16) -> String {
    format!(
        "{bin} --headless --port {port} --cwd {home}",
        bin = shell_quote(&platform.bin_path()),
        home = shell_quote(&platform.home),
    )
}

pub fn systemd_unit(platform: &RemotePlatform, port: u16) -> String {
    let path_line = platform
        .login_path
        .as_deref()
        .map(|path| format!("Environment=\"PATH={}\"\n", path.replace('"', "")))
        .unwrap_or_default();
    format!(
        "[Unit]\n\
         Description=CC-Panes headless server\n\
         After=network-online.target\n\
         \n\
         [Service]\n\
         {path_line}\
         ExecStart={exec}\n\
         Restart=on-failure\n\
         RestartSec=3\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exec = exec_line(platform, port),
    )
}

/// 安装并（重新）启动服务。
pub fn install_service(
    session: &Session,
    platform: &RemotePlatform,
    port: u16,
) -> Result<InstallOutcome> {
    let mut warnings = Vec::new();
    if platform.has_systemd_user {
        let unit_dir = format!("{}/.config/systemd/user", platform.home);
        let unit = systemd_unit(platform, port);
        let script = format!(
            "mkdir -p {dir} && cat > {dir}/{SERVICE_NAME}.service <<'CCPANES_UNIT'\n{unit}CCPANES_UNIT\n\
             systemctl --user daemon-reload && systemctl --user enable {SERVICE_NAME} >/dev/null 2>&1; \
             systemctl --user restart {SERVICE_NAME}",
            dir = shell_quote(&unit_dir),
        );
        remote_exec(session, &script)?.ok("Install the systemd user service")?;
        if platform.linger == Some(false) {
            warnings.push(format!(
                "systemd linger is off for {user}: the server stops when you log out. Run `sudo loginctl enable-linger {user}` on the server to keep it running.",
                user = platform.user
            ));
        }
        return Ok(InstallOutcome {
            manager: "systemd".to_string(),
            warnings,
        });
    }

    let dir = format!("{}/.cc-panes", platform.home);
    let pidfile = format!("{dir}/{SERVICE_NAME}.pid");
    let log = format!("{dir}/{SERVICE_NAME}.log");
    let env_path = platform
        .login_path
        .as_deref()
        .map(|path| format!("PATH={} ", shell_quote(path)))
        .unwrap_or_default();
    let script = format!(
        "mkdir -p {dir}; \
         if [ -f {pid} ]; then kill \"$(cat {pid})\" 2>/dev/null; sleep 1; fi; \
         nohup env {env_path}{exec} > {log} 2>&1 < /dev/null & echo $! > {pid}",
        dir = shell_quote(&dir),
        pid = shell_quote(&pidfile),
        log = shell_quote(&log),
        exec = exec_line(platform, port),
    );
    remote_exec(session, &script)?.ok("Start cc-panes-web")?;
    warnings.push(
        "No systemd user session on this machine: the server was started with nohup and will not restart after a reboot.".to_string(),
    );
    Ok(InstallOutcome {
        manager: "nohup".to_string(),
        warnings,
    })
}

/// 在远端创建设备令牌，返回明文令牌（只此一次）。
pub fn create_remote_token(
    session: &Session,
    platform: &RemotePlatform,
    device_name: &str,
) -> Result<String> {
    let output = remote_exec(
        session,
        &format!(
            "{} token create --name {} --json",
            shell_quote(&platform.bin_path()),
            shell_quote(device_name)
        ),
    )?
    .ok("Create a device token on the server")?;
    let json: serde_json::Value = serde_json::from_str(output.trim())
        .context("Unexpected output from `cc-panes-web token create`")?;
    json.get("token")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .context("`cc-panes-web token create` did not return a token")
}

/// 远端服务最近的日志（排障用）。
pub fn recent_logs(session: &Session, platform: &RemotePlatform) -> String {
    let command = if platform.has_systemd_user {
        format!("journalctl --user -u {SERVICE_NAME} -n 30 --no-pager 2>&1")
    } else {
        format!(
            "tail -n 30 {} 2>&1",
            shell_quote(&format!("{}/.cc-panes/{SERVICE_NAME}.log", platform.home))
        )
    };
    remote_exec(session, &command)
        .map(|out| out.stdout)
        .unwrap_or_default()
}

/// 等服务端口在远端起来（`/api/health` 不需要令牌）。
pub fn wait_until_listening(session: &Session, port: u16, timeout: Duration) -> Result<()> {
    let deadline = std::time::Instant::now() + timeout;
    let probe = format!(
        "(command -v curl >/dev/null && curl -fsS -o /dev/null http://127.0.0.1:{port}/api/health) || \
         (command -v wget >/dev/null && wget -q -O /dev/null http://127.0.0.1:{port}/api/health)"
    );
    loop {
        if remote_exec(session, &probe).is_ok_and(|out| out.status == 0) {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            bail!("cc-panes-web did not start listening on 127.0.0.1:{port}");
        }
        std::thread::sleep(Duration::from_millis(700));
    }
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform() -> RemotePlatform {
        RemotePlatform {
            os: "linux".into(),
            arch: "x86_64".into(),
            home: "/home/dev".into(),
            user: "dev".into(),
            login_path: Some("/home/dev/.nvm/versions/node/v20/bin:/usr/bin".into()),
            has_systemd_user: true,
            linger: Some(false),
            installed_version: None,
        }
    }

    #[test]
    fn unit_runs_headless_on_loopback_with_login_path() {
        let unit = systemd_unit(&platform(), 18765);
        assert!(unit.contains("ExecStart='/home/dev/.cc-panes/bin/cc-panes-web' --headless --port 18765 --cwd '/home/dev'"));
        assert!(unit.contains("Environment=\"PATH=/home/dev/.nvm/versions/node/v20/bin:/usr/bin\""));
        assert!(!unit.contains("--host"));
    }

    #[test]
    fn normalizes_uname() {
        assert_eq!(normalize_os("Darwin\n"), "macos");
        assert_eq!(normalize_os("Linux"), "linux");
        assert_eq!(normalize_arch("arm64"), "aarch64");
        assert_eq!(normalize_arch("amd64"), "x86_64");
        assert_eq!(platform().asset_suffix(), "linux-x86_64");
    }

    #[test]
    fn quotes_single_quotes() {
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}
