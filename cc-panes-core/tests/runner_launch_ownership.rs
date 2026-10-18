use cc_panes_core::models::{RunnerLaunchSuggestedAction, RunnerProfileDraft};
use cc_panes_core::repository::{Database, RunnerRepository};
use cc_panes_core::services::{ProcessMonitorService, RunnerService};
use std::{net::TcpListener, sync::Arc};

#[test]
fn launch_plan_only_suggests_killing_the_requested_profile() {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    let service = RunnerService::new(
        Arc::new(RunnerRepository::new(Arc::new(
            Database::new_fallback().unwrap(),
        ))),
        Arc::new(ProcessMonitorService::new()),
    );
    let create = |name: &str| {
        service
            .upsert_profile(RunnerProfileDraft {
                id: None,
                project_path: format!("/test/{name}"),
                workspace_name: None,
                name: name.into(),
                command: "fixture".into(),
                cwd: format!("/test/{name}"),
                runtime_kind: "local".into(),
                wsl_distro: None,
                ssh_machine_id: None,
                env: Default::default(),
                expected_ports: vec![port],
                tool_hint: None,
            })
            .unwrap()
    };
    let a = create("a");
    let b = create("b");
    service
        .register_instance(
            Some(&a.id),
            &a.project_path,
            None,
            None,
            std::process::id(),
            "local",
            "fixture",
            &a.cwd,
        )
        .unwrap();
    let self_plan = service.plan_launch(&a.id).unwrap();
    assert_eq!(
        self_plan.suggested_actions,
        vec![RunnerLaunchSuggestedAction::KillSelfThenStart]
    );
    let other_plan = service.plan_launch(&b.id).unwrap();
    assert!(other_plan
        .conflicts
        .iter()
        .all(|c| c.owning_profile_id.as_deref() == Some(a.id.as_str())));
    assert_eq!(
        other_plan.suggested_actions,
        vec![RunnerLaunchSuggestedAction::AskUserBeforeKill]
    );
    // Deliberately never call any kill API; this test owns only an ephemeral listener.
}
