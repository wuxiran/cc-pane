//! Tailscale 只读探测：为「远程访问引导」设置页提供本机 tailscale 状态。
//!
//! 安全边界（借鉴 claude_codex_bridge 的模型）：探测只执行 `tailscale status --json`；
//! `tailscale serve` 只在用户点「一键开启 / 关闭」时执行（[`tailscale_serve_enable`] /
//! [`tailscale_serve_disable`]），绝不自动执行，也绝不执行 `tailscale up`，
//! 不读写任何 Tailscale 凭证/ACL。测试只覆盖输出解析，不运行 CLI。

use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DETECT_TIMEOUT: Duration = Duration::from_secs(3);
/// `tailscale serve` 在 tailnet 未开启 Serve 时会打印审批链接并一直等待，必须有界。
const SERVE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    /// tailscale CLI 是否可用（PATH 中可执行）
    pub installed: bool,
    /// BackendState："Running" / "NeedsLogin" / "Stopped"；None = 未安装或解析失败
    pub backend_state: Option<String>,
    /// 本机节点 MagicDNS 名（去尾点），Tailscale Serve 的访问域名
    pub dns_name: Option<String>,
    pub tailscale_ips: Vec<String>,
}

pub fn detect_tailscale() -> TailscaleStatus {
    let output = cc_panes_core::utils::output_with_timeout(
        Command::new(tailscale_binary()).args(["status", "--json"]),
        DETECT_TIMEOUT,
    );
    let output = match output {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return TailscaleStatus {
                installed: false,
                backend_state: None,
                dns_name: None,
                tailscale_ips: Vec::new(),
            };
        }
        Err(_) => {
            // 存在但执行失败（超时等）：报告已安装、状态未知
            return TailscaleStatus {
                installed: true,
                backend_state: None,
                dns_name: None,
                tailscale_ips: Vec::new(),
            };
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_tailscale_status(&stdout)
}

/// GUI 应用的 PATH 往往不含 tailscale（macOS 从 Finder 启动、Windows 安装目录）：
/// PATH 找不到时回落到各平台的默认安装位置。
pub(crate) fn tailscale_binary() -> PathBuf {
    if let Ok(path) = which::which("tailscale") {
        return path;
    }
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ]
    } else if cfg!(windows) {
        &[r"C:\Program Files\Tailscale\tailscale.exe"]
    } else {
        &["/usr/bin/tailscale", "/usr/local/bin/tailscale"]
    };
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("tailscale"))
}

/// `tailscale serve` 当前是否把 HTTPS 指向本机 Web 服务。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleServeStatus {
    pub active: bool,
    /// tailnet 内的访问地址（`https://<机器名>.<tailnet>.ts.net/`）
    pub url: Option<String>,
}

/// 一键开启 / 关闭失败的原因（前端按 kind 显示对应文案）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TailscaleServeError {
    /// 找不到 tailscale CLI
    NotInstalled,
    /// tailscale 未登录 / 未连接
    #[serde(rename_all = "camelCase")]
    NotRunning {
        backend_state: Option<String>,
    },
    /// tailnet 管理员尚未开启 Serve（CLI 给出审批链接）
    NeedsApproval {
        url: Option<String>,
    },
    /// 本机无权修改 serve 配置（Linux 需 `sudo tailscale set --operator=$USER`）
    PermissionDenied {
        detail: String,
    },
    /// Web 访问没有设置密码：经 Serve 进来的流量算远程访问，必须先有密码
    PasswordRequired,
    Failed {
        detail: String,
    },
}

struct RunOutput {
    success: bool,
    timed_out: bool,
    text: String,
}

fn run_tailscale(args: &[&str], timeout: Duration) -> Result<RunOutput, TailscaleServeError> {
    let mut child = Command::new(tailscale_binary())
        .args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => TailscaleServeError::NotInstalled,
            _ => TailscaleServeError::Failed {
                detail: error.to_string(),
            },
        })?;
    let collected = Arc::new(Mutex::new(Vec::<u8>::new()));
    for stream in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let sink = collected.clone();
        let spawned = std::thread::Builder::new()
            .name("tailscale-output".into())
            .spawn(move || {
                let mut stream = stream;
                let mut buf = [0_u8; 4096];
                while let Ok(read) = stream.read(&mut buf) {
                    if read == 0 {
                        break;
                    }
                    sink.lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .extend_from_slice(&buf[..read]);
                }
            });
        if let Err(error) = spawned {
            // 读不了输出就不能判断成败，也不能让子进程卡在写满的管道上
            let _ = child.kill();
            let _ = child.wait();
            return Err(TailscaleServeError::Failed {
                detail: error.to_string(),
            });
        }
    }
    let deadline = Instant::now() + timeout;
    let (success, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.success(), false),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break (false, true);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                return Err(TailscaleServeError::Failed {
                    detail: error.to_string(),
                })
            }
        }
    };
    // 给读线程一点时间把尾部输出收完（不 join：孙进程可能还握着管道）
    std::thread::sleep(Duration::from_millis(100));
    let text =
        String::from_utf8_lossy(&collected.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    Ok(RunOutput {
        success,
        timed_out,
        text,
    })
}

fn ensure_running() -> Result<(), TailscaleServeError> {
    let status = detect_tailscale();
    if !status.installed {
        return Err(TailscaleServeError::NotInstalled);
    }
    if status.backend_state.as_deref() != Some("Running") {
        return Err(TailscaleServeError::NotRunning {
            backend_state: status.backend_state,
        });
    }
    Ok(())
}

/// 读 `tailscale serve status --json`，判断 HTTPS 是否指向本机 `port`。只读。
pub fn tailscale_serve_status(port: u16) -> Result<TailscaleServeStatus, TailscaleServeError> {
    let output = run_tailscale(&["serve", "status", "--json"], DETECT_TIMEOUT)?;
    if !output.success {
        return Err(classify_serve_failure(&output.text));
    }
    Ok(parse_serve_status(&output.text, port))
}

/// 用户点击「一键开启」：`tailscale serve --bg --https=443 http://127.0.0.1:<port>`。
pub fn tailscale_serve_enable(port: u16) -> Result<TailscaleServeStatus, TailscaleServeError> {
    ensure_running()?;
    let target = format!("http://127.0.0.1:{port}");
    let output = run_tailscale(&["serve", "--bg", "--https=443", &target], SERVE_TIMEOUT)?;
    if output.timed_out || !output.success {
        return Err(classify_serve_failure(&output.text));
    }
    let status = tailscale_serve_status(port)?;
    if status.active {
        Ok(status)
    } else {
        Err(TailscaleServeError::Failed {
            detail: truncate(&output.text),
        })
    }
}

/// 用户点击「关闭」：只在 HTTPS 443 确实指向本机 Web 服务时执行 `tailscale serve --https=443 off`，
/// 不碰用户为别的服务配置的 serve。
pub fn tailscale_serve_disable(port: u16) -> Result<TailscaleServeStatus, TailscaleServeError> {
    ensure_running()?;
    if !tailscale_serve_status(port)?.active {
        return Ok(TailscaleServeStatus {
            active: false,
            url: None,
        });
    }
    let output = run_tailscale(&["serve", "--https=443", "off"], SERVE_TIMEOUT)?;
    if output.timed_out || !output.success {
        return Err(classify_serve_failure(&output.text));
    }
    tailscale_serve_status(port)
}

fn truncate(text: &str) -> String {
    text.trim().chars().take(500).collect()
}

fn classify_serve_failure(text: &str) -> TailscaleServeError {
    let lower = text.to_ascii_lowercase();
    if lower.contains("login.tailscale.com") || lower.contains("serve is not enabled") {
        let url = text
            .split_whitespace()
            .find(|word| word.starts_with("https://login.tailscale.com/"))
            .map(|word| word.trim_end_matches(['.', ',', ')']).to_string());
        return TailscaleServeError::NeedsApproval { url };
    }
    if lower.contains("access denied")
        || lower.contains("permission denied")
        || lower.contains("--operator")
    {
        return TailscaleServeError::PermissionDenied {
            detail: truncate(text),
        };
    }
    TailscaleServeError::Failed {
        detail: truncate(text),
    }
}

/// serve 配置形如 `{"Web":{"host.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:18080"}}}}}`。
fn parse_serve_status(json_text: &str, port: u16) -> TailscaleServeStatus {
    let inactive = TailscaleServeStatus {
        active: false,
        url: None,
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json_text) else {
        return inactive;
    };
    let Some(web) = value.get("Web").and_then(|web| web.as_object()) else {
        return inactive;
    };
    let targets = [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        port.to_string(),
    ];
    for (host_port, config) in web {
        let proxy = config
            .pointer("/Handlers/~1/Proxy")
            .and_then(|proxy| proxy.as_str())
            .map(|proxy| proxy.trim_end_matches('/'));
        if proxy.is_some_and(|proxy| targets.iter().any(|target| target == proxy)) {
            let host = host_port.strip_suffix(":443").unwrap_or(host_port);
            return TailscaleServeStatus {
                active: true,
                url: Some(format!("https://{host}/")),
            };
        }
    }
    inactive
}

fn parse_tailscale_status(json_text: &str) -> TailscaleStatus {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json_text) else {
        return TailscaleStatus {
            installed: true,
            backend_state: None,
            dns_name: None,
            tailscale_ips: Vec::new(),
        };
    };
    let backend_state = value
        .get("BackendState")
        .and_then(|state| state.as_str())
        .map(str::to_string);
    let self_node = value.get("Self");
    let dns_name = self_node
        .and_then(|node| node.get("DNSName"))
        .and_then(|name| name.as_str())
        .map(|name| name.trim_end_matches('.').to_string())
        .filter(|name| !name.is_empty());
    let tailscale_ips = self_node
        .and_then(|node| node.get("TailscaleIPs"))
        .and_then(|ips| ips.as_array())
        .map(|ips| {
            ips.iter()
                .filter_map(|ip| ip.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    TailscaleStatus {
        installed: true,
        backend_state,
        dns_name,
        tailscale_ips,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_running_status() {
        let status = parse_tailscale_status(
            r#"{
                "BackendState": "Running",
                "Self": {
                    "DNSName": "my-pc.tailnet-1234.ts.net.",
                    "TailscaleIPs": ["100.64.0.5", "fd7a::1"]
                }
            }"#,
        );
        assert!(status.installed);
        assert_eq!(status.backend_state.as_deref(), Some("Running"));
        assert_eq!(
            status.dns_name.as_deref(),
            Some("my-pc.tailnet-1234.ts.net")
        );
        assert_eq!(status.tailscale_ips, vec!["100.64.0.5", "fd7a::1"]);
    }

    #[test]
    fn parses_needs_login_without_self() {
        let status = parse_tailscale_status(r#"{"BackendState": "NeedsLogin"}"#);
        assert!(status.installed);
        assert_eq!(status.backend_state.as_deref(), Some("NeedsLogin"));
        assert!(status.dns_name.is_none());
        assert!(status.tailscale_ips.is_empty());
    }

    #[test]
    fn serve_status_matches_our_port_only() {
        let json = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"my-pc.tail-1.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:18080"}}}}}"#;
        assert_eq!(
            parse_serve_status(json, 18080),
            TailscaleServeStatus {
                active: true,
                url: Some("https://my-pc.tail-1.ts.net/".into())
            }
        );
        assert!(!parse_serve_status(json, 3000).active);
        assert!(!parse_serve_status("{}", 18080).active);
        assert!(!parse_serve_status("not json", 18080).active);
    }

    #[test]
    fn serve_failures_are_classified() {
        let approval = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n";
        assert_eq!(
            classify_serve_failure(approval),
            TailscaleServeError::NeedsApproval {
                url: Some("https://login.tailscale.com/f/serve?node=abc123".into())
            }
        );
        assert!(matches!(
            classify_serve_failure("Access denied: serve config denied\nUse 'sudo tailscale serve' or 'tailscale set --operator=$USER'"),
            TailscaleServeError::PermissionDenied { .. }
        ));
        assert!(matches!(
            classify_serve_failure("something odd"),
            TailscaleServeError::Failed { .. }
        ));
    }

    #[test]
    fn malformed_json_degrades_to_unknown_state() {
        let status = parse_tailscale_status("not json");
        assert!(status.installed);
        assert!(status.backend_state.is_none());
    }
}
