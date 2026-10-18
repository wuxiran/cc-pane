use super::*;
use crate::models::SshMachineUpsertRequest;
use crate::services::SshMachineService;
use tempfile::TempDir;

fn machine(id: &str, jump_id: Option<&str>) -> SshMachine {
    let mut machine: SshMachine = serde_json::from_value(serde_json::json!({
        "id": id, "name": id, "host": "127.0.0.1", "port": 22,
        "authMethod": "password", "createdAt": "2026-10-19", "updatedAt": "2026-10-19"
    }))
    .unwrap();
    machine.jump_host = jump_id.map(|id| SshJumpHost {
        machine_id: Some(id.to_string()),
        host: None,
        port: 22,
        user: None,
        identity_file: None,
    });
    machine
}

fn request(machine: SshMachine) -> SshMachineUpsertRequest {
    SshMachineUpsertRequest {
        machine,
        remember_password: false,
        password_input: None,
        clear_stored_password: false,
        remember_proxy_password: false,
        proxy_password_input: None,
        clear_stored_proxy_password: false,
    }
}

fn legacy_config(machines: Vec<SshMachine>) -> (TempDir, SshConnectionService, SshMachineService) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ssh-machines.json");
    fs::write(
        &path,
        serde_json::to_vec(&SshMachineConfig { machines }).unwrap(),
    )
    .unwrap();
    let credentials = Arc::new(SshCredentialService::new_memory());
    let connection = SshConnectionService::new(credentials.clone(), dir.path().join("known-hosts"));
    let saved = SshMachineService::new(path, credentials);
    (dir, connection, saved)
}

#[test]
fn round4_legacy_jump_cycles_and_nested_routes_fail_before_network_io() {
    for machines in [
        vec![machine("A", Some("A"))],
        vec![machine("A", Some("B")), machine("B", Some("A"))],
        vec![
            machine("A", Some("B")),
            machine("B", Some("C")),
            machine("C", Some("A")),
        ],
        vec![
            machine("A", Some("B")),
            machine("B", Some("C")),
            machine("C", None),
        ],
    ] {
        let first = machines[0].clone();
        let (_dir, connection, _) = legacy_config(machines);
        let probe_error = connection.probe_machine(&first).unwrap_err().to_string();
        assert!(
            probe_error.contains("refers to itself") || probe_error.contains("nested jump hosts")
        );
        let connect_error = connection
            .connect_machine(&first)
            .err()
            .expect("nested connection route must fail")
            .to_string();
        assert!(connect_error.contains("nested jump hosts"));
    }
}

#[tokio::test]
async fn round4_password_connectivity_check_reports_legacy_cycle_as_unreachable() {
    let (_dir, _, saved) = legacy_config(vec![machine("A", Some("B")), machine("B", Some("A"))]);
    let result = saved.check_connectivity("A").await.unwrap();
    assert!(!result.reachable);
    assert!(result.message.contains("nested jump hosts"));
}

#[test]
fn round4_save_rejects_cycles_without_changing_disk_or_credentials() {
    let (dir, _, saved) = legacy_config(vec![machine("A", None)]);
    saved.add(request(machine("B", Some("A")))).unwrap();
    let path = dir.path().join("ssh-machines.json");
    let before = fs::read(&path).unwrap();
    let mut edit = request(machine("A", Some("B")));
    edit.remember_password = true;
    edit.password_input = Some("must-not-be-stored".into());
    assert!(saved
        .update(edit)
        .unwrap_err()
        .to_string()
        .contains("nested jump hosts"));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(saved.get("A").unwrap().jump_host.is_none());
    assert!(saved.load_password("A").unwrap().is_none());
}

#[test]
fn round4_changing_a_referenced_jump_cannot_invalidate_existing_routes() {
    let (dir, _, saved) = legacy_config(vec![
        machine("A", None),
        machine("B", Some("A")),
        machine("C", None),
    ]);
    let path = dir.path().join("ssh-machines.json");
    let before = fs::read(&path).unwrap();
    // A -> C is valid on its own, but would turn existing B -> A into two hops.
    assert!(saved.update(request(machine("A", Some("C")))).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(saved.add(request(machine("D", Some("B")))).is_err());
    assert!(saved.get("D").is_none());
}

#[test]
fn round4_saving_self_or_missing_jump_is_rejected_but_valid_routes_can_be_repaired() {
    let (_dir, _, saved) = legacy_config(vec![machine("A", Some("B")), machine("B", Some("A"))]);
    assert!(saved.add(request(machine("self", Some("self")))).is_err());
    assert!(saved
        .add(request(machine("missing", Some("absent"))))
        .is_err());
    saved.update(request(machine("A", None))).unwrap();
    assert!(saved.get("A").unwrap().jump_host.is_none());
    assert_eq!(
        saved
            .get("B")
            .unwrap()
            .jump_host
            .unwrap()
            .machine_id
            .as_deref(),
        Some("A")
    );
}

#[test]
fn round4_single_hop_probe_reaches_the_jump_endpoint() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut jump = machine("jump", None);
    jump.port = listener.local_addr().unwrap().port();
    let target = machine("target", Some("jump"));
    let (_dir, connection, _) = legacy_config(vec![target.clone(), jump]);
    connection.probe_machine(&target).unwrap();
    let _accepted = listener
        .accept()
        .expect("probe must connect to the jump, not the target");
}
