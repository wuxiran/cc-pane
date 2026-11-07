//! 直连设备（局域网 / Tailscale）的远程终端冒烟（docs/111 阶段 4）：
//! `cargo run -p cc-panes-core --example device_direct_e2e -- <base_url> <token>`
use std::sync::Arc;
use std::time::Duration;

use cc_panes_core::models::{CreateSessionRequest, DeviceAddRequest, DeviceConnection};
use cc_panes_core::services::remote_terminal::RemoteSessionRouter;
use cc_panes_core::services::{
    DeviceService, MemoryDeviceTokenStore, SshConnectionService, SshCredentialService,
    SshMachineService, TerminalBackend,
};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [base_url, token, ..] = args.as_slice() else {
        anyhow::bail!("usage: device_direct_e2e <base_url> <token>");
    };
    let dir = tempfile::tempdir()?;
    let credentials = Arc::new(SshCredentialService::new_memory());
    let devices = Arc::new(DeviceService::new(
        dir.path().join("devices.json"),
        Arc::new(MemoryDeviceTokenStore::default()),
        Arc::new(SshMachineService::new(
            dir.path().join("ssh-machines.json"),
            credentials.clone(),
        )),
        Arc::new(SshConnectionService::new(
            credentials,
            dir.path().join("ssh-known-hosts"),
        )),
    ));
    let device = devices.add(DeviceAddRequest {
        name: "direct".into(),
        connection: DeviceConnection::Direct {
            base_url: base_url.clone(),
        },
        token: Some(token.clone()),
    })?;
    let router = RemoteSessionRouter::new(dir.path().join("remote-sessions.json"), devices);
    let backend = router.device_backend(&device.id);
    let request: CreateSessionRequest = serde_json::from_value(serde_json::json!({
        "projectPath": std::env::temp_dir(), "cols": 100, "rows": 30, "cliTool": "none",
    }))?;
    let session_id = backend.create_session(request)?;
    backend.write(&session_id, "echo DIRECT_$((40+2))\n")?;
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(250));
        if format!("{:?}", backend.get_session_output(&session_id, 50)?).contains("DIRECT_42") {
            println!("direct remote shell roundtrip: ok ({session_id})");
            backend.kill(&session_id)?;
            println!("E2E OK");
            return Ok(());
        }
    }
    anyhow::bail!("remote output never arrived")
}
