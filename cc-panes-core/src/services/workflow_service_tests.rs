use super::*;
use crate::models::task_binding::{CreateTaskBindingRequest, UpdateTaskBindingRequest};
use crate::repository::{Database, TaskBindingRepository};
use std::sync::Mutex;

struct Fixture {
    bindings: TaskBindingService,
    workflows: WorkflowService,
    woken: Arc<Mutex<Vec<String>>>,
}

fn fixture() -> Fixture {
    let db = Arc::new(Database::new_in_memory().unwrap());
    let workflows = WorkflowService::new(Arc::new(WorkflowRepository::new(db.clone())));
    let woken = Arc::new(Mutex::new(Vec::new()));
    let sink = woken.clone();
    workflows.set_waker(Arc::new(move |id: &str| {
        sink.lock().unwrap().push(id.to_string())
    }));
    Fixture {
        bindings: TaskBindingService::new(Arc::new(TaskBindingRepository::new(db))),
        workflows,
        woken,
    }
}

fn binding(f: &Fixture, parent: Option<&str>, metadata: Option<Value>) -> TaskBinding {
    f.bindings
        .create(CreateTaskBindingRequest {
            title: "t".into(),
            role: None,
            parent_id: parent.map(str::to_string),
            plan_path: None,
            normalized_plan_path: None,
            prompt: None,
            session_id: None,
            resume_id: None,
            pane_id: None,
            tab_id: None,
            todo_id: None,
            project_path: "/repo".into(),
            workspace_name: None,
            cli_tool: None,
            worker_kind: None,
            metadata,
        })
        .unwrap()
}

fn create(f: &Fixture, parent: &str, stages: Value) -> Workflow {
    f.workflows
        .create(serde_json::from_value(json!({"workflowId": parent, "stages": stages})).unwrap())
        .unwrap()
}

/// What the orchestrator driver does for one job: child binding with receipt, then settle.
fn run_job(f: &Fixture, job: &DispatchJob, with_session: bool) -> TaskBinding {
    let child = binding(f, Some(&job.workflow_id), Some(job.receipt_metadata()));
    if with_session {
        f.bindings
            .update(
                &child.id,
                UpdateTaskBindingRequest {
                    session_id: Some(format!("pty-{}", job.task_key)),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    f.workflows.dispatch_succeeded(job, &child.id).unwrap();
    child
}

fn complete(f: &Fixture, id: &str, result: Option<Value>) {
    f.bindings
        .update(
            id,
            UpdateTaskBindingRequest {
                status: Some(TaskBindingStatus::Completed),
                completion_summary: Some("ok".into()),
                metadata: result.map(|result| json!({"result": result})),
                ..Default::default()
            },
        )
        .unwrap();
}

#[test]
fn end_to_end_with_approval_and_structured_result_flow() {
    let f = fixture();
    let parent = binding(&f, None, None);
    create(
        &f,
        &parent.id,
        json!([
            {"key": "plan", "tasks": [{"key": "api", "prompt": "design",
                "resultSchema": {"type": "object", "required": ["files"]}}]},
            {"key": "impl", "requiresApproval": true,
             "tasks": [{"key": "rust", "prompt": "implement {{stages.plan.api}}"}]}
        ]),
    );
    assert_eq!(f.woken.lock().unwrap().as_slice(), [parent.id.clone()]);

    let first = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert_eq!(first.jobs.len(), 1);
    let child = run_job(&f, &first.jobs[0], true);

    // A second advance before the child finishes dispatches nothing (idempotent).
    let idle = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert!(idle.jobs.is_empty());

    complete(&f, &child.id, Some(json!({"files": ["api.rs"]})));
    let gated = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert_eq!(gated.entered_approval, Some(1));
    assert!(gated.jobs.is_empty());
    assert_eq!(gated.workflow.status, WorkflowStatus::WaitingApproval);

    let approved = f
        .workflows
        .approve_stage(&parent.id, StageSelector::Key("impl".into()), "desktop")
        .unwrap();
    assert!(approved.stages[1].approved_at.is_some());
    let second = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert_eq!(second.jobs.len(), 1);
    assert_eq!(second.jobs[0].prompt, r#"implement {"files":["api.rs"]}"#);
    let impl_child = run_job(&f, &second.jobs[0], true);
    complete(&f, &impl_child.id, None);
    let done = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert_eq!(done.workflow.status, WorkflowStatus::Done);
}

#[test]
fn terminal_observer_fires_for_children_only() {
    let f = fixture();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    f.bindings
        .set_terminal_observer(Arc::new(move |binding: &TaskBinding| {
            sink.lock().unwrap().push(binding.id.clone())
        }));
    let parent = binding(&f, None, None);
    let child = binding(&f, Some(&parent.id), None);
    complete(&f, &parent.id, None);
    f.bindings
        .update(
            &child.id,
            UpdateTaskBindingRequest {
                progress: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(seen.lock().unwrap().is_empty());
    complete(&f, &child.id, None);
    assert_eq!(seen.lock().unwrap().as_slice(), [child.id]);
}

#[test]
fn recovery_adopts_releases_or_fails_claimed_tasks() {
    let f = fixture();
    let parent = binding(&f, None, None);
    create(
        &f,
        &parent.id,
        json!([{"key": "s", "tasks": [
            {"key": "launched", "prompt": "a"},
            {"key": "never", "prompt": "b"},
            {"key": "half", "prompt": "c"}
        ]}]),
    );
    // Simulate a crash: all three claimed, receipts in various states, nothing settled.
    let outcome = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert_eq!(outcome.jobs.len(), 3);
    let launched = binding(
        &f,
        Some(&parent.id),
        Some(outcome.jobs[0].receipt_metadata()),
    );
    f.bindings
        .update(
            &launched.id,
            UpdateTaskBindingRequest {
                session_id: Some("pty-1".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let half = binding(
        &f,
        Some(&parent.id),
        Some(outcome.jobs[2].receipt_metadata()),
    );
    // An unrelated sibling with a receipt for another workflow must not be adopted.
    binding(
        &f,
        Some(&parent.id),
        Some(json!({"workflowTask": {"workflowId": "other", "stageIndex": 0, "taskKey": "never"}})),
    );

    // Restart: nothing may be re-dispatched before recovery.
    let touched = f.workflows.recover_claims(&f.bindings).unwrap();
    assert_eq!(touched, [parent.id.clone()]);
    let workflow = f.workflows.get(&parent.id).unwrap().unwrap();
    let tasks = &workflow.stages[0].tasks;
    assert_eq!(tasks[0].status, WorkflowTaskStatus::Running);
    assert_eq!(tasks[0].binding_id.as_deref(), Some(launched.id.as_str()));
    assert_eq!(tasks[1].status, WorkflowTaskStatus::Pending);
    assert_eq!(tasks[2].status, WorkflowTaskStatus::Failed);
    assert_eq!(tasks[2].binding_id.as_deref(), Some(half.id.as_str()));

    // After recovery the stage fails (task 'half'), so 'never' is not dispatched either.
    let after = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert!(after.jobs.is_empty());
    assert_eq!(after.workflow.status, WorkflowStatus::Failed);
}

#[test]
fn recovery_redispatches_only_unreceipted_tasks_and_keeps_done_stages() {
    let f = fixture();
    let parent = binding(&f, None, None);
    create(
        &f,
        &parent.id,
        json!([
            {"key": "a", "tasks": [{"key": "x", "prompt": "x"}]},
            {"key": "b", "tasks": [{"key": "y", "prompt": "y"}]}
        ]),
    );
    let first = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    let child = run_job(&f, &first.jobs[0], true);
    complete(&f, &child.id, None);
    let second = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert_eq!(second.jobs[0].task_key, "y");
    // Crash right after the claim, before any binding existed.
    f.workflows.recover_claims(&f.bindings).unwrap();
    let resumed = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert_eq!(resumed.jobs.len(), 1);
    assert_eq!(resumed.jobs[0].task_key, "y");
    assert_eq!(resumed.workflow.stages[0].status, WorkflowStageStatus::Done);
}

#[test]
fn dispatch_failure_fails_the_workflow() {
    let f = fixture();
    let parent = binding(&f, None, None);
    create(
        &f,
        &parent.id,
        json!([{"key": "a", "tasks": [{"key": "x", "prompt": "x"}]}]),
    );
    let first = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    f.workflows
        .dispatch_failed(&first.jobs[0], "project not registered")
        .unwrap();
    let after = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert_eq!(after.workflow.status, WorkflowStatus::Failed);
    assert!(after.workflow.stages[0]
        .error
        .as_deref()
        .unwrap()
        .contains("project not registered"));
}

#[test]
fn deleting_the_parent_fails_the_workflow() {
    let f = fixture();
    let parent = binding(&f, None, None);
    create(
        &f,
        &parent.id,
        json!([{"key": "a", "tasks": [{"key": "x", "prompt": "x"}]}]),
    );
    f.bindings.delete(&parent.id).unwrap();
    let after = f
        .workflows
        .advance(&parent.id, &f.bindings)
        .unwrap()
        .unwrap();
    assert_eq!(after.workflow.status, WorkflowStatus::Failed);
    assert!(after.jobs.is_empty());
}

#[test]
fn claim_recovery_decision_table() {
    let f = fixture();
    let mut receipt = binding(&f, None, None);
    assert_eq!(claim_recovery(None), ClaimRecovery::Release);
    assert_eq!(
        claim_recovery(Some(&receipt)),
        ClaimRecovery::Fail(receipt.id.clone())
    );
    receipt.session_id = Some("pty".into());
    assert_eq!(
        claim_recovery(Some(&receipt)),
        ClaimRecovery::Adopt(receipt.id.clone())
    );
}
