//! 多设备端到端冒烟（docs/111-multi-device.md）：对一台真实 SSH 主机跑完整的
//! 部署 → 令牌 → 端口转发 → HTTP 访问流程。不在 CI 里跑，需要手动准备主机：
//!
//! ```text
//! cargo run -p cc-panes-core --example device_e2e -- \
//!   <host> <port> <user> <identity_file> <server_binary> [remote_port]
//! ```
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use cc_panes_core::models::{DeviceAddRequest, DeviceConnection, SshMachineUpsertRequest};
use cc_panes_core::services::device_deploy;
use cc_panes_core::services::{
    DeviceService, MemoryDeviceTokenStore, SshConnectionService, SshCredentialService,
    SshMachineService,
};

fn http_get(addr: &str, path: &str, token: Option<&str>) -> anyhow::Result<(u16, String)> {
    let mut stream = TcpStream::connect(addr)?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    let auth = token
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\n{auth}Connection: close\r\n\r\n"
    )?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let status = response
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    Ok((status, body))
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [host, port, user, identity, binary, ..] = args.as_slice() else {
        anyhow::bail!(
            "usage: device_e2e <host> <port> <user> <identity_file> <server_binary> [remote_port]"
        );
    };
    let remote_port: u16 = args.get(5).map_or(Ok(18765), |value| value.parse())?;
    let dir = tempfile::tempdir()?;
    let credentials = Arc::new(SshCredentialService::new_memory());
    let connection = Arc::new(SshConnectionService::new(
        credentials.clone(),
        dir.path().join("ssh-known-hosts"),
    ));
    let machines = Arc::new(SshMachineService::with_connection_service(
        dir.path().join("ssh-machines.json"),
        credentials,
        connection.clone(),
    ));
    let machine = machines.add(SshMachineUpsertRequest {
        machine: serde_json::from_value(serde_json::json!({
            "id": "e2e",
            "name": "e2e",
            "host": host,
            "port": port.parse::<u16>()?,
            "user": user,
            "authMethod": "key",
            "identityFile": identity,
            "createdAt": "", "updatedAt": "",
        }))?,
        remember_password: false,
        password_input: None,
        clear_stored_password: false,
        remember_proxy_password: false,
        proxy_password_input: None,
        clear_stored_proxy_password: false,
    })?;
    let devices = DeviceService::new(
        dir.path().join("devices.json"),
        Arc::new(MemoryDeviceTokenStore::default()),
        machines.clone(),
        connection.clone(),
    );
    let device = devices.add(DeviceAddRequest {
        name: "e2e".into(),
        connection: DeviceConnection::Ssh {
            machine_id: machine.id.clone(),
            remote_port,
        },
        token: None,
    })?;

    // 部署前：端口转发能建，但对端没服务。
    let endpoint = devices.endpoint(&device.id)?;
    let addr = endpoint.base_url.trim_start_matches("http://").to_string();
    println!("forward before deploy: {addr}");
    match http_get(&addr, "/api/health", None) {
        Ok((status, _)) => println!("  before deploy -> HTTP {status} (expected failure)"),
        Err(error) => println!("  before deploy -> {error} (expected)"),
    }

    let session = connection.connect_machine(&machine)?;
    let platform = device_deploy::probe_platform(&session)?;
    println!("platform: {platform:?}");
    device_deploy::upload_binary(&session, &platform, std::path::Path::new(binary), |_, _| {})?;
    let install = device_deploy::install_service(&session, &platform, remote_port)?;
    println!("install: {install:?}");
    device_deploy::wait_until_listening(&session, remote_port, Duration::from_secs(20))?;
    let token = device_deploy::create_remote_token(&session, &platform, "e2e-desktop")?;
    devices.set_token(&device.id, &token)?;

    devices.drop_forward(&device.id);
    let endpoint = devices.endpoint(&device.id)?;
    let addr = endpoint.base_url.trim_start_matches("http://").to_string();
    let (status, _) = http_get(&addr, "/api/device/info", None)?;
    println!("no token -> HTTP {status}");
    assert_eq!(status, 401, "headless server must require a token");
    let (status, body) = http_get(&addr, "/api/device/info", endpoint.token.as_deref())?;
    println!("device/info -> HTTP {status}: {body}");
    assert_eq!(status, 200);
    let (status, body) = http_get(&addr, "/api/environment", endpoint.token.as_deref())?;
    assert_eq!(status, 200);
    let env: serde_json::Value = serde_json::from_str(&body)?;
    let claude = env["cliTools"]
        .as_array()
        .and_then(|tools| tools.iter().find(|tool| tool["id"] == "claude"))
        .cloned();
    println!("claude on remote: {claude:?}");

    // 并发多个连接走同一条 SSH 会话
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let addr = addr.clone();
            let token = endpoint.token.clone();
            std::thread::spawn(move || http_get(&addr, "/api/workspaces", token.as_deref()))
        })
        .collect();
    for handle in handles {
        let (status, _) = handle.join().expect("thread")?;
        assert_eq!(status, 200);
    }
    println!("8 concurrent requests over one tunnel: ok");

    // 再部署一次（升级路径）：旧进程被替换，令牌仍有效
    device_deploy::upload_binary(&session, &platform, std::path::Path::new(binary), |_, _| {})?;
    device_deploy::install_service(&session, &platform, remote_port)?;
    device_deploy::wait_until_listening(&session, remote_port, Duration::from_secs(20))?;
    let (status, _) = http_get(&addr, "/api/device/info", endpoint.token.as_deref())?;
    println!("after redeploy -> HTTP {status}");
    assert_eq!(status, 200);
    println!("E2E OK");
    Ok(())
}
