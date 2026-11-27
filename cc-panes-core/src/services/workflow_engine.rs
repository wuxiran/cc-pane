//! Pure state machine for staged workflows (docs/114 §4).
//!
//! Everything here is side-effect free: the driver feeds a snapshot plus what
//! it observed on child TaskBindings, and gets back the next snapshot and the
//! tasks it may dispatch now. Persistence, dispatch and notifications live in
//! the driver.

use crate::models::workflow::*;
use crate::services::json_schema_lite;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const MAX_STAGES: usize = 20;
pub const MAX_TASKS_PER_STAGE: usize = 16;
const DEFAULT_POOL: &str = "claude";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRef {
    pub stage_index: u32,
    pub task_key: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reduction {
    pub workflow: Workflow,
    /// Tasks that may be claimed and dispatched now (already limited by pools).
    pub dispatch: Vec<TaskRef>,
    /// Stage that entered `waiting_approval` during this pass.
    pub entered_approval: Option<u32>,
}

/// Pool a task counts against: explicit pool, else its CLI tool, else claude.
pub fn pool_for(spec: &WorkflowTaskSpec) -> String {
    spec.pool
        .as_deref()
        .or(spec.cli_tool.as_deref())
        .map(str::trim)
        .filter(|pool| !pool.is_empty())
        .unwrap_or(DEFAULT_POOL)
        .to_string()
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Validate a create request before anything is persisted.
pub fn validate_create(request: &CreateWorkflowRequest) -> Result<(), String> {
    if request.workflow_id.trim().is_empty() {
        return Err("workflow id (parent binding id) is required".into());
    }
    if request.stages.is_empty() || request.stages.len() > MAX_STAGES {
        return Err(format!("stages must contain 1..={MAX_STAGES} entries"));
    }
    for (pool, limit) in &request.pools {
        if pool.trim().is_empty() || *limit == 0 {
            return Err(format!("pool '{pool}' must have a name and a limit >= 1"));
        }
    }
    let mut stage_keys = HashSet::new();
    for stage in &request.stages {
        if !valid_key(&stage.key) {
            return Err(format!(
                "stage key '{}' must be 1-64 chars of [A-Za-z0-9_-]",
                stage.key
            ));
        }
        if !stage_keys.insert(stage.key.as_str()) {
            return Err(format!("duplicate stage key '{}'", stage.key));
        }
        validate_stage_tasks(stage)?;
    }
    Ok(())
}

fn validate_stage_tasks(stage: &WorkflowStageSpec) -> Result<(), String> {
    if stage.tasks.is_empty() || stage.tasks.len() > MAX_TASKS_PER_STAGE {
        return Err(format!(
            "stage '{}' must have 1..={MAX_TASKS_PER_STAGE} tasks",
            stage.key
        ));
    }
    let mut task_keys = HashSet::new();
    for task in &stage.tasks {
        if !valid_key(&task.key) {
            return Err(format!(
                "task key '{}' in stage '{}' must be 1-64 chars of [A-Za-z0-9_-]",
                task.key, stage.key
            ));
        }
        if !task_keys.insert(task.key.as_str()) {
            return Err(format!(
                "duplicate task key '{}' in stage '{}'",
                task.key, stage.key
            ));
        }
        if task.prompt.trim().is_empty() {
            return Err(format!(
                "task '{}.{}' has an empty prompt",
                stage.key, task.key
            ));
        }
        if let Some(schema) = &task.result_schema {
            json_schema_lite::check_schema(schema)
                .map_err(|error| format!("task '{}.{}': {error}", stage.key, task.key))?;
        }
    }
    Ok(())
}

/// Build the initial snapshot for a validated request.
pub fn initial_workflow(request: &CreateWorkflowRequest, now: &str) -> Workflow {
    let stages = request
        .stages
        .iter()
        .enumerate()
        .map(|(index, stage)| WorkflowStage {
            index: index as u32,
            key: stage.key.clone(),
            title: stage.title.clone(),
            requires_approval: stage.requires_approval,
            status: WorkflowStageStatus::Pending,
            approved_at: None,
            approved_via: None,
            error: None,
            tasks: stage
                .tasks
                .iter()
                .map(|spec| WorkflowTask {
                    key: spec.key.clone(),
                    pool: pool_for(spec),
                    spec: spec.clone(),
                    status: WorkflowTaskStatus::Pending,
                    binding_id: None,
                    result: None,
                    error: None,
                })
                .collect(),
        })
        .collect();
    Workflow {
        id: request.workflow_id.clone(),
        status: WorkflowStatus::Running,
        pools: request.pools.clone(),
        stages,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    }
}

/// Fold child observations into running tasks.
fn apply_observations(task: &mut WorkflowTask, observations: &HashMap<String, ChildObservation>) {
    if task.status != WorkflowTaskStatus::Running {
        return;
    }
    let Some(observation) = task.binding_id.as_ref().and_then(|id| observations.get(id)) else {
        return;
    };
    match observation {
        ChildObservation::Active => {}
        ChildObservation::Missing => fail_task(task, "child task binding was deleted".into()),
        ChildObservation::Failed { reason } => fail_task(
            task,
            reason
                .clone()
                .filter(|reason| !reason.trim().is_empty())
                .unwrap_or_else(|| "child task failed".into()),
        ),
        ChildObservation::Completed { result } => complete_task(task, result.clone()),
    }
}

fn fail_task(task: &mut WorkflowTask, error: String) {
    task.status = WorkflowTaskStatus::Failed;
    task.error = Some(error);
}

fn complete_task(task: &mut WorkflowTask, result: Option<Value>) {
    if let Some(schema) = &task.spec.result_schema {
        let Some(value) = result.as_ref() else {
            return fail_task(task, "missing structured result".into());
        };
        if let Err(errors) = json_schema_lite::validate(schema, value) {
            return fail_task(task, format!("result failed schema: {}", errors.join("; ")));
        }
    }
    task.status = WorkflowTaskStatus::Done;
    task.result = result;
}

/// Pending tasks that fit into their pool, in declaration order.
fn pick_dispatch(stage: &WorkflowStage, pools: &BTreeMap<String, u32>) -> Vec<TaskRef> {
    let mut in_flight: HashMap<&str, u32> = HashMap::new();
    for task in stage.tasks.iter().filter(|task| task.status.is_in_flight()) {
        *in_flight.entry(task.pool.as_str()).or_default() += 1;
    }
    let mut picked = Vec::new();
    for task in &stage.tasks {
        if task.status != WorkflowTaskStatus::Pending {
            continue;
        }
        let used = in_flight.entry(task.pool.as_str()).or_default();
        if pools.get(&task.pool).is_some_and(|limit| *used >= *limit) {
            continue;
        }
        *used += 1;
        picked.push(TaskRef {
            stage_index: stage.index,
            task_key: task.key.clone(),
        });
    }
    picked
}

/// Advance the workflow as far as the observations allow.
pub fn reduce(
    mut workflow: Workflow,
    observations: &HashMap<String, ChildObservation>,
) -> Reduction {
    let mut reduction = Reduction {
        workflow: workflow.clone(),
        dispatch: Vec::new(),
        entered_approval: None,
    };
    if workflow.status.is_terminal() {
        return reduction;
    }
    for stage in &mut workflow.stages {
        for task in &mut stage.tasks {
            apply_observations(task, observations);
        }
    }
    let pools = workflow.pools.clone();
    loop {
        let Some(stage) = workflow
            .stages
            .iter_mut()
            .find(|stage| stage.status != WorkflowStageStatus::Done)
        else {
            workflow.status = WorkflowStatus::Done;
            break;
        };
        match stage.status {
            WorkflowStageStatus::Done => unreachable!("filtered above"),
            WorkflowStageStatus::Failed => {
                workflow.status = WorkflowStatus::Failed;
                break;
            }
            WorkflowStageStatus::Pending | WorkflowStageStatus::WaitingApproval => {
                if stage.requires_approval && stage.approved_at.is_none() {
                    if stage.status == WorkflowStageStatus::Pending {
                        reduction.entered_approval = Some(stage.index);
                    }
                    stage.status = WorkflowStageStatus::WaitingApproval;
                    workflow.status = WorkflowStatus::WaitingApproval;
                    break;
                }
                stage.status = WorkflowStageStatus::Running;
            }
            WorkflowStageStatus::Running => {
                if let Some(failed) = stage
                    .tasks
                    .iter()
                    .find(|task| task.status == WorkflowTaskStatus::Failed)
                {
                    stage.error = Some(format!(
                        "task '{}' failed: {}",
                        failed.key,
                        failed.error.as_deref().unwrap_or("unknown error")
                    ));
                    stage.status = WorkflowStageStatus::Failed;
                    workflow.status = WorkflowStatus::Failed;
                    break;
                }
                if stage
                    .tasks
                    .iter()
                    .all(|task| task.status == WorkflowTaskStatus::Done)
                {
                    stage.status = WorkflowStageStatus::Done;
                    continue;
                }
                reduction.dispatch = pick_dispatch(stage, &pools);
                workflow.status = WorkflowStatus::Running;
                break;
            }
        }
    }
    reduction.workflow = workflow;
    reduction
}

/// Record an approval. Returns the stage index and whether anything changed;
/// approving an already-approved stage is a no-op.
pub fn approve(
    workflow: &mut Workflow,
    selector: &StageSelector,
    via: &str,
    now: &str,
) -> Result<(u32, bool), String> {
    let stage = workflow
        .stages
        .iter_mut()
        .find(|stage| match selector {
            StageSelector::Key(key) => &stage.key == key,
            StageSelector::Index(index) => stage.index == *index,
        })
        .ok_or_else(|| format!("stage {selector:?} not found"))?;
    if stage.approved_at.is_some() {
        return Ok((stage.index, false));
    }
    if stage.status != WorkflowStageStatus::WaitingApproval {
        return Err(format!(
            "stage '{}' is {}, not waiting for approval",
            stage.key,
            stage.status.as_str()
        ));
    }
    stage.approved_at = Some(now.to_string());
    stage.approved_via = Some(via.to_string());
    Ok((stage.index, true))
}

fn stage_results(stage: &WorkflowStage) -> Value {
    let map: Map<String, Value> = stage
        .tasks
        .iter()
        .map(|task| (task.key.clone(), task.result.clone().unwrap_or(Value::Null)))
        .collect();
    Value::Object(map)
}

fn resolve_reference(workflow: &Workflow, stage_index: u32, reference: &str) -> Option<Value> {
    let visible = |stage: &&WorkflowStage| stage.index < stage_index;
    if reference == "prev" {
        let previous = stage_index.checked_sub(1)?;
        return workflow
            .stages
            .iter()
            .find(|stage| stage.index == previous)
            .map(stage_results);
    }
    let rest = reference.strip_prefix("stages.")?;
    let (stage_key, task_key) = match rest.split_once('.') {
        Some((stage, task)) => (stage, Some(task)),
        None => (rest, None),
    };
    let stage = workflow
        .stages
        .iter()
        .filter(visible)
        .find(|stage| stage.key == stage_key)?;
    match task_key {
        None => Some(stage_results(stage)),
        Some(task_key) => stage
            .tasks
            .iter()
            .find(|task| task.key == task_key)
            .map(|task| task.result.clone().unwrap_or(Value::Null)),
    }
}

/// Expand `{{prev}}`, `{{stages.<key>}}` and `{{stages.<key>.<task>}}` with
/// earlier stages' results (compact JSON). Unknown references stay verbatim.
pub fn render_prompt(template: &str, workflow: &Workflow, stage_index: u32) -> String {
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            output.push_str(&rest[start..]);
            return output;
        };
        let reference = after[..end].trim();
        match resolve_reference(workflow, stage_index, reference) {
            Some(value) => output.push_str(&value.to_string()),
            None => output.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    output
}

/// Instruction appended to a dispatched prompt when a result schema is set.
pub fn result_instruction(binding_id: &str, schema: &Value) -> String {
    format!(
        "\n\n---\n完成时调用 update_task_binding(id=\"{binding_id}\", status=\"completed\", \
         completionSummary=…, result=<JSON>)，result 必须符合以下 JSON Schema（不符合会被拒绝，可修正后重试）：\n{schema}"
    )
}

#[cfg(test)]
#[path = "workflow_engine_tests.rs"]
mod tests;
