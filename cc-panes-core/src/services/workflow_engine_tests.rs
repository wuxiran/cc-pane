use super::*;
use serde_json::json;

fn task(key: &str, cli: Option<&str>) -> WorkflowTaskSpec {
    WorkflowTaskSpec {
        key: key.into(),
        prompt: format!("do {key}"),
        cli_tool: cli.map(str::to_string),
        ..Default::default()
    }
}

fn stage(key: &str, approval: bool, tasks: Vec<WorkflowTaskSpec>) -> WorkflowStageSpec {
    WorkflowStageSpec {
        key: key.into(),
        title: None,
        requires_approval: approval,
        tasks,
    }
}

fn request(stages: Vec<WorkflowStageSpec>) -> CreateWorkflowRequest {
    CreateWorkflowRequest {
        workflow_id: "wf".into(),
        stages,
        pools: BTreeMap::new(),
    }
}

fn keys(reduction: &Reduction) -> Vec<String> {
    reduction
        .dispatch
        .iter()
        .map(|task| format!("{}.{}", task.stage_index, task.task_key))
        .collect()
}

/// What the driver does after a successful dispatch.
fn mark_running(workflow: &mut Workflow, reduction: &Reduction) {
    for picked in &reduction.dispatch {
        let task = workflow.stages[picked.stage_index as usize]
            .tasks
            .iter_mut()
            .find(|task| task.key == picked.task_key)
            .unwrap();
        task.status = WorkflowTaskStatus::Running;
        task.binding_id = Some(format!("b-{}-{}", picked.stage_index, picked.task_key));
    }
}

fn observe(pairs: &[(&str, ChildObservation)]) -> HashMap<String, ChildObservation> {
    pairs
        .iter()
        .map(|(id, observation)| (id.to_string(), observation.clone()))
        .collect()
}

fn done(result: Option<Value>) -> ChildObservation {
    ChildObservation::Completed { result }
}

#[test]
fn validation_rejects_bad_shapes() {
    assert!(validate_create(&request(vec![])).is_err());
    assert!(validate_create(&request(vec![stage("a", false, vec![])])).is_err());
    let dup = request(vec![
        stage("a", false, vec![task("x", None)]),
        stage("a", false, vec![task("y", None)]),
    ]);
    assert!(validate_create(&dup)
        .unwrap_err()
        .contains("duplicate stage key"));
    let dup_task = request(vec![stage(
        "a",
        false,
        vec![task("x", None), task("x", None)],
    )]);
    assert!(validate_create(&dup_task).is_err());
    assert!(validate_create(&request(vec![stage("a b", false, vec![task("x", None)])])).is_err());
    let mut empty_prompt = task("x", None);
    empty_prompt.prompt = "  ".into();
    assert!(validate_create(&request(vec![stage("a", false, vec![empty_prompt])])).is_err());
    let mut bad_schema = task("x", None);
    bad_schema.result_schema = Some(json!("string"));
    assert!(validate_create(&request(vec![stage("a", false, vec![bad_schema])])).is_err());
    let mut zero_pool = request(vec![stage("a", false, vec![task("x", None)])]);
    zero_pool.pools.insert("codex".into(), 0);
    assert!(validate_create(&zero_pool).is_err());
    assert!(validate_create(&request(vec![stage("a", false, vec![task("x", None)])])).is_ok());
}

#[test]
fn stages_run_in_order_and_parallel_tasks_converge() {
    let req = request(vec![
        stage("build", false, vec![task("rust", None), task("ts", None)]),
        stage("review", false, vec![task("r", None)]),
    ]);
    let workflow = initial_workflow(&req, "t0");
    let first = reduce(workflow, &HashMap::new());
    assert_eq!(keys(&first), ["0.rust", "0.ts"]);
    assert_eq!(
        first.workflow.stages[0].status,
        WorkflowStageStatus::Running
    );
    assert_eq!(
        first.workflow.stages[1].status,
        WorkflowStageStatus::Pending
    );

    let mut workflow = first.workflow.clone();
    mark_running(&mut workflow, &first);
    // One branch done: no convergence yet, nothing new to dispatch.
    let half = reduce(workflow, &observe(&[("b-0-rust", done(None))]));
    assert!(half.dispatch.is_empty());
    assert_eq!(half.workflow.stages[0].status, WorkflowStageStatus::Running);

    let both = reduce(
        half.workflow,
        &observe(&[
            ("b-0-ts", done(None)),
            ("b-0-rust", ChildObservation::Active),
        ]),
    );
    assert_eq!(both.workflow.stages[0].status, WorkflowStageStatus::Done);
    assert_eq!(keys(&both), ["1.r"]);

    let mut workflow = both.workflow.clone();
    mark_running(&mut workflow, &both);
    let end = reduce(workflow, &observe(&[("b-1-r", done(None))]));
    assert_eq!(end.workflow.status, WorkflowStatus::Done);
    assert!(end.dispatch.is_empty());
}

#[test]
fn approval_gate_stops_until_approved_and_is_idempotent() {
    let req = request(vec![
        stage("plan", false, vec![task("p", None)]),
        stage("impl", true, vec![task("i", None)]),
    ]);
    let first = reduce(initial_workflow(&req, "t0"), &HashMap::new());
    let mut workflow = first.workflow.clone();
    mark_running(&mut workflow, &first);
    let gated = reduce(workflow, &observe(&[("b-0-p", done(None))]));
    assert_eq!(gated.entered_approval, Some(1));
    assert!(gated.dispatch.is_empty());
    assert_eq!(gated.workflow.status, WorkflowStatus::WaitingApproval);
    assert_eq!(
        gated.workflow.stages[1].status,
        WorkflowStageStatus::WaitingApproval
    );

    // Still waiting: re-entering does not re-announce.
    let again = reduce(gated.workflow.clone(), &HashMap::new());
    assert_eq!(again.entered_approval, None);
    assert!(again.dispatch.is_empty());

    let mut workflow = again.workflow;
    assert!(approve(
        &mut workflow,
        &StageSelector::Key("plan".into()),
        "desktop",
        "t1"
    )
    .is_err());
    assert_eq!(
        approve(
            &mut workflow,
            &StageSelector::Key("impl".into()),
            "desktop",
            "t1"
        ),
        Ok((1, true))
    );
    assert_eq!(
        approve(&mut workflow, &StageSelector::Index(1), "mcp", "t2"),
        Ok((1, false))
    );
    assert_eq!(workflow.stages[1].approved_via.as_deref(), Some("desktop"));
    let resumed = reduce(workflow, &HashMap::new());
    assert_eq!(keys(&resumed), ["1.i"]);
    assert_eq!(resumed.workflow.status, WorkflowStatus::Running);
}

#[test]
fn first_stage_can_require_approval() {
    let req = request(vec![stage("only", true, vec![task("x", None)])]);
    let gated = reduce(initial_workflow(&req, "t0"), &HashMap::new());
    assert_eq!(gated.entered_approval, Some(0));
    assert!(gated.dispatch.is_empty());
}

#[test]
fn failure_fails_stage_and_workflow_without_dispatching_more() {
    let mut req = request(vec![
        stage(
            "s",
            false,
            vec![
                task("a", Some("codex")),
                task("b", Some("codex")),
                task("c", Some("codex")),
            ],
        ),
        stage("next", false, vec![task("n", None)]),
    ]);
    req.pools.insert("codex".into(), 2);
    let first = reduce(initial_workflow(&req, "t0"), &HashMap::new());
    assert_eq!(keys(&first), ["0.a", "0.b"]);
    let mut workflow = first.workflow.clone();
    mark_running(&mut workflow, &first);
    let failed = reduce(
        workflow,
        &observe(&[(
            "b-0-a",
            ChildObservation::Failed {
                reason: Some("boom".into()),
            },
        )]),
    );
    assert_eq!(failed.workflow.status, WorkflowStatus::Failed);
    assert_eq!(
        failed.workflow.stages[0].status,
        WorkflowStageStatus::Failed
    );
    assert!(failed.workflow.stages[0]
        .error
        .as_deref()
        .unwrap()
        .contains("boom"));
    assert!(failed.dispatch.is_empty(), "queued task 'c' must not start");
    // Terminal workflows are inert.
    let after = reduce(failed.workflow.clone(), &observe(&[("b-0-b", done(None))]));
    assert_eq!(after.workflow, failed.workflow);
}

#[test]
fn pools_queue_overflow_and_release_slots() {
    let mut req = request(vec![stage(
        "s",
        false,
        vec![
            task("a", Some("codex")),
            task("b", Some("codex")),
            task("c", Some("codex")),
            task("d", None),
        ],
    )]);
    req.pools.insert("codex".into(), 2);
    let first = reduce(initial_workflow(&req, "t0"), &HashMap::new());
    // codex capped at 2; claude pool undeclared = unlimited.
    assert_eq!(keys(&first), ["0.a", "0.b", "0.d"]);
    let mut workflow = first.workflow.clone();
    mark_running(&mut workflow, &first);
    let still_full = reduce(workflow.clone(), &HashMap::new());
    assert!(still_full.dispatch.is_empty());
    let freed = reduce(workflow, &observe(&[("b-0-a", done(None))]));
    assert_eq!(keys(&freed), ["0.c"]);
}

#[test]
fn claimed_tasks_hold_their_pool_slot() {
    let mut req = request(vec![stage(
        "s",
        false,
        vec![task("a", Some("codex")), task("b", Some("codex"))],
    )]);
    req.pools.insert("codex".into(), 1);
    let mut workflow = reduce(initial_workflow(&req, "t0"), &HashMap::new()).workflow;
    workflow.stages[0].tasks[0].status = WorkflowTaskStatus::Claimed;
    assert!(reduce(workflow, &HashMap::new()).dispatch.is_empty());
}

#[test]
fn schema_tasks_need_a_valid_result() {
    let schema =
        json!({"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}});
    let mut with_schema = task("a", None);
    with_schema.result_schema = Some(schema);
    let req = request(vec![stage(
        "s",
        false,
        vec![with_schema.clone(), task("plain", None)],
    )]);
    let first = reduce(initial_workflow(&req, "t0"), &HashMap::new());
    let mut workflow = first.workflow.clone();
    mark_running(&mut workflow, &first);

    let missing = reduce(workflow.clone(), &observe(&[("b-0-a", done(None))]));
    assert_eq!(
        missing.workflow.stages[0].tasks[0].error.as_deref(),
        Some("missing structured result")
    );
    let invalid = reduce(
        workflow.clone(),
        &observe(&[("b-0-a", done(Some(json!({"ok": 1}))))]),
    );
    assert!(invalid.workflow.stages[0].tasks[0]
        .error
        .as_deref()
        .unwrap()
        .contains("schema"));
    let ok = reduce(
        workflow,
        &observe(&[
            ("b-0-a", done(Some(json!({"ok": true})))),
            ("b-0-plain", done(None)),
        ]),
    );
    assert_eq!(ok.workflow.status, WorkflowStatus::Done);
    assert_eq!(
        ok.workflow.stages[0].tasks[0].result,
        Some(json!({"ok": true}))
    );
}

#[test]
fn deleted_child_fails_the_task() {
    let req = request(vec![stage("s", false, vec![task("a", None)])]);
    let first = reduce(initial_workflow(&req, "t0"), &HashMap::new());
    let mut workflow = first.workflow.clone();
    mark_running(&mut workflow, &first);
    let gone = reduce(workflow, &observe(&[("b-0-a", ChildObservation::Missing)]));
    assert_eq!(gone.workflow.status, WorkflowStatus::Failed);
}

#[test]
fn done_stages_are_never_redispatched_after_reload() {
    // A snapshot reloaded after restart: stage 0 done, stage 1 running with one task in flight.
    let req = request(vec![
        stage("a", false, vec![task("x", None)]),
        stage("b", false, vec![task("y", None), task("z", None)]),
    ]);
    let mut workflow = initial_workflow(&req, "t0");
    workflow.stages[0].status = WorkflowStageStatus::Done;
    workflow.stages[0].tasks[0].status = WorkflowTaskStatus::Done;
    workflow.stages[1].status = WorkflowStageStatus::Running;
    workflow.stages[1].tasks[0].status = WorkflowTaskStatus::Running;
    workflow.stages[1].tasks[0].binding_id = Some("b-y".into());
    let resumed = reduce(workflow, &HashMap::new());
    assert_eq!(keys(&resumed), ["1.z"]);
}

#[test]
fn prompts_reference_earlier_structured_results() {
    let req = request(vec![
        stage("plan", false, vec![task("api", None)]),
        stage("impl", false, vec![task("rust", None)]),
        stage("review", false, vec![task("r", None)]),
    ]);
    let mut workflow = initial_workflow(&req, "t0");
    workflow.stages[0].tasks[0].result = Some(json!({"files": ["a.rs"]}));
    workflow.stages[1].tasks[0].result = Some(json!({"pr": 7}));
    let rendered = render_prompt(
        "prev={{prev}} plan={{ stages.plan }} api={{stages.plan.api}} none={{stages.review}} x={{unknown}} {{open",
        &workflow,
        2,
    );
    assert_eq!(
        rendered,
        r#"prev={"rust":{"pr":7}} plan={"api":{"files":["a.rs"]}} api={"files":["a.rs"]} none={{stages.review}} x={{unknown}} {{open"#
    );
    // Stage 0 has no previous stage; its placeholder stays.
    assert_eq!(render_prompt("{{prev}}", &workflow, 0), "{{prev}}");
}

#[test]
fn pool_defaults_follow_cli_tool() {
    assert_eq!(pool_for(&task("a", Some("codex"))), "codex");
    assert_eq!(pool_for(&task("a", None)), "claude");
    let mut explicit = task("a", Some("codex"));
    explicit.pool = Some("heavy".into());
    assert_eq!(pool_for(&explicit), "heavy");
}
