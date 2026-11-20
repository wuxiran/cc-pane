//! 连通性检测之外的两项探测：远端是什么系统、上面有没有在跑 CC-Panes。
//!
//! 「设备」视图据此决定给「部署」（只有 Linux/macOS 能一键部署）还是「连接」（对方已在跑），
//! MCP / cc-panes-ctl 也复用同一份结果。两项都是尽力而为：探不出来就留空，不让检测本身失败。

use crate::models::ssh_machine::SshMachine;
use crate::services::device_deploy::remote_exec;
use serde::Serialize;
use ssh2::Session;
use std::time::Duration;

/// CC-Panes Web 服务常见端口：默认 18080、dev 常用 18081、一键部署默认 18765。
pub const CC_PANES_WEB_PORTS: [u16; 3] = [18080, 18081, 18765];
const HTTP_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// 远端已在运行的 CC-Panes Web 服务。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCcPanes {
    pub base_url: String,
    pub port: u16,
    /// `/api/health` 与设备配对同批（0.12.22）加入：答得上来才能配对。
    pub pairing_supported: bool,
}

/// 远端系统：先 `uname -s`（Linux/macOS），失败再 `cmd /c ver`（cmd 与 PowerShell 两种默认 shell 都能跑）。
pub fn detect_remote_os(session: &Session) -> Option<String> {
    if let Ok(out) = remote_exec(session, "uname -s") {
        if out.status == 0 {
            let os = normalize_uname(&out.stdout);
            if !os.is_empty() {
                return Some(os);
            }
        }
    }
    let out = remote_exec(session, "cmd /c ver").ok()?;
    is_windows_ver_output(&out.stdout).then(|| "windows".to_string())
}

fn normalize_uname(stdout: &str) -> String {
    let first = stdout
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match first.as_str() {
        "darwin" => "macos".to_string(),
        other => other.to_string(),
    }
}

fn is_windows_ver_output(stdout: &str) -> bool {
    stdout.to_ascii_lowercase().contains("windows")
}

/// 走代理/跳板或主机名是回环地址时，本机直连 HTTP 到不了对方，干脆不探。
pub fn http_probe_host(machine: &SshMachine) -> Option<String> {
    if machine.uses_routed_connection() {
        return None;
    }
    let host = machine.host.trim();
    let lower = host.to_ascii_lowercase();
    if host.is_empty() || lower == "localhost" || lower == "::1" || lower.starts_with("127.") {
        return None;
    }
    Some(if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    })
}

/// 依次探常见端口：`/api/auth/status` 回 JSON 且带 `authRequired` 即认定是 CC-Panes。
pub async fn detect_remote_cc_panes(host: &str) -> Option<RemoteCcPanes> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_PROBE_TIMEOUT)
        .no_proxy()
        .build()
        .ok()?;
    let probes = CC_PANES_WEB_PORTS
        .iter()
        .map(|port| probe_port(&client, host, *port));
    futures_util::future::join_all(probes)
        .await
        .into_iter()
        .flatten()
        .next()
}

async fn probe_port(client: &reqwest::Client, host: &str, port: u16) -> Option<RemoteCcPanes> {
    let base_url = format!("http://{host}:{port}");
    let status = fetch_json(client, &format!("{base_url}/api/auth/status")).await?;
    if !looks_like_cc_panes_auth_status(&status) {
        return None;
    }
    let health = fetch_json(client, &format!("{base_url}/api/health")).await;
    Some(RemoteCcPanes {
        base_url,
        port,
        pairing_supported: health.as_ref().is_some_and(health_supports_pairing),
    })
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Option<serde_json::Value> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    // 老版本对未知 /api 路径回 SPA 的 HTML，解析失败即视为不支持。
    response.json::<serde_json::Value>().await.ok()
}

fn looks_like_cc_panes_auth_status(value: &serde_json::Value) -> bool {
    value
        .get("authRequired")
        .is_some_and(serde_json::Value::is_boolean)
}

fn health_supports_pairing(value: &serde_json::Value) -> bool {
    value.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ssh_machine::AuthMethod;

    fn machine(host: &str) -> SshMachine {
        SshMachine {
            id: "m".into(),
            name: "m".into(),
            host: host.into(),
            port: 22,
            user: None,
            auth_method: AuthMethod::Key,
            identity_file: None,
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
    fn uname_maps_darwin_to_macos() {
        assert_eq!(normalize_uname("Darwin\n"), "macos");
        assert_eq!(normalize_uname("Linux\n"), "linux");
    }

    #[test]
    fn windows_ver_output_is_recognized() {
        assert!(is_windows_ver_output(
            "\r\nMicrosoft Windows [Version 10.0.26100.4349]\r\n"
        ));
        assert!(!is_windows_ver_output("ver: command not found"));
    }

    #[test]
    fn loopback_and_routed_hosts_are_not_http_probed() {
        assert_eq!(http_probe_host(&machine("127.0.0.1")), None);
        assert_eq!(http_probe_host(&machine("localhost")), None);
        assert_eq!(
            http_probe_host(&machine("192.168.2.9")).as_deref(),
            Some("192.168.2.9")
        );
        assert_eq!(
            http_probe_host(&machine("fe80::1")).as_deref(),
            Some("[fe80::1]")
        );
    }

    #[test]
    fn auth_status_and_health_shapes() {
        assert!(looks_like_cc_panes_auth_status(
            &serde_json::json!({"authRequired": true, "authenticated": false})
        ));
        assert!(!looks_like_cc_panes_auth_status(
            &serde_json::json!({"ok": true})
        ));
        assert!(health_supports_pairing(&serde_json::json!({"ok": true})));
        assert!(!health_supports_pairing(
            &serde_json::json!({"status": "up"})
        ));
    }
}
