use super::*;
use crate::repository::Database;
use serde_json::{json, Value};
use std::sync::Mutex;

#[derive(Default)]
struct RecordingEmitter(Mutex<Vec<Value>>);

impl EventEmitter for RecordingEmitter {
    fn emit(&self, _event: &str, payload: Value) -> anyhow::Result<()> {
        self.0.lock().unwrap().push(payload);
        Ok(())
    }
}

fn service() -> TaskBindingService {
    let db = Arc::new(Database::new_in_memory().unwrap());
    TaskBindingService::new(Arc::new(TaskBindingRepository::new(db)))
}

fn request(session_id: &str) -> RegisterPlanLeaderRequest {
    serde_json::from_value(json!({
        "planPath": "D:/repo/.claude/plans/plan.md",
        "projectPath": "D:/repo",
        "sessionId": session_id
    }))
    .unwrap()
}

fn set_outcome(service: &TaskBindingService, id: &str, status: TaskBindingStatus) {
    service
        .update(
            id,
            UpdateTaskBindingRequest {
                status: Some(status),
                progress: Some(75),
                completion_summary: Some("previous attempt".into()),
                exit_code: Some(7),
                metadata: Some(json!({ "retained": true })),
                ..Default::default()
            },
        )
        .unwrap();
}

#[test]
fn leader_reregistration_restarts_terminal_bindings_and_preserves_children() {
    for status in [TaskBindingStatus::Failed, TaskBindingStatus::Completed] {
        for session_id in ["pty-original", "pty-replacement"] {
            let service = service();
            let first = service
                .register_plan_leader(request("pty-original"))
                .unwrap();
            set_outcome(&service, &first.id, status.clone());
            let worker = service
                .create(
                    serde_json::from_value(json!({
                        "title": "Worker", "role": "worker", "parentId": first.id,
                        "projectPath": "D:/repo", "sessionId": "pty-worker"
                    }))
                    .unwrap(),
                )
                .unwrap();
            let emitter = Arc::new(RecordingEmitter::default());
            service.set_emitter(emitter.clone());

            let restarted = service.register_plan_leader(request(session_id)).unwrap();

            assert_eq!(restarted.id, first.id);
            assert_eq!(restarted.created_at, first.created_at);
            assert_eq!(restarted.session_id.as_deref(), Some(session_id));
            assert_eq!(restarted.status, TaskBindingStatus::Running);
            assert_eq!(restarted.progress, 0);
            assert_eq!(restarted.exit_code, None);
            assert_eq!(restarted.completion_summary, None);
            assert_eq!(restarted.metadata, Some(json!({ "retained": true })));
            let persisted = service.get(&first.id).unwrap().unwrap();
            assert_eq!(
                serde_json::to_value(persisted).unwrap(),
                serde_json::to_value(&restarted).unwrap()
            );
            assert_eq!(service.query(TaskBindingQuery::default()).unwrap().total, 2);
            assert_eq!(
                service.get(&worker.id).unwrap().unwrap().parent_id,
                Some(first.id)
            );
            let events = emitter.0.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["op"], "register");
            assert_eq!(events[0]["binding"]["status"], "running");
        }
    }
}

#[test]
fn leader_reregistration_keeps_progress_for_the_same_active_session() {
    for status in [
        TaskBindingStatus::Pending,
        TaskBindingStatus::Running,
        TaskBindingStatus::Waiting,
    ] {
        let service = service();
        let first = service
            .register_plan_leader(request("pty-original"))
            .unwrap();
        service
            .update(
                &first.id,
                UpdateTaskBindingRequest {
                    status: Some(status),
                    progress: Some(42),
                    ..Default::default()
                },
            )
            .unwrap();

        let registered = service
            .register_plan_leader(request("pty-original"))
            .unwrap();

        assert_eq!(registered.id, first.id);
        assert_eq!(registered.status, TaskBindingStatus::Running);
        assert_eq!(registered.progress, 42);
        assert_eq!(registered.exit_code, None);
    }
}

#[test]
fn leader_reregistration_rebinds_a_session_without_accepting_its_late_exit() {
    let service = service();
    let first = service
        .register_plan_leader(request("pty-original"))
        .unwrap();
    set_outcome(&service, &first.id, TaskBindingStatus::Running);

    let restarted = service
        .register_plan_leader(request("pty-replacement"))
        .unwrap();

    assert_eq!(restarted.progress, 0);
    assert_eq!(restarted.exit_code, None);
    assert_eq!(restarted.completion_summary, None);
    assert!(service
        .record_terminal_exit("pty-original", 7)
        .unwrap()
        .is_none());
    assert_eq!(
        service.get(&first.id).unwrap().unwrap().status,
        TaskBindingStatus::Running
    );
}

#[test]
fn leader_reregistration_rejects_invalid_changes_without_resetting_the_result() {
    let service = service();
    let first = service
        .register_plan_leader(request("pty-original"))
        .unwrap();
    set_outcome(&service, &first.id, TaskBindingStatus::Failed);
    let before = service.get(&first.id).unwrap().unwrap();
    let emitter = Arc::new(RecordingEmitter::default());
    service.set_emitter(emitter.clone());
    let mut invalid = request("pty-replacement");
    invalid.title = Some("   ".into());

    assert!(service.register_plan_leader(invalid).is_err());

    let after = service.get(&first.id).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(after).unwrap()
    );
    assert!(emitter.0.lock().unwrap().is_empty());
}
