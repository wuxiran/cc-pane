//! Staged workflow service (docs/114): persistence + observation + recovery.
//!
//! The service never launches sessions itself. [`WorkflowService::advance`]
//! returns claimed [`DispatchJob`]s; the orchestrator driver dispatches them and
//! reports back through [`WorkflowService::dispatch_succeeded`] /
//! [`WorkflowService::dispatch_failed`].

use crate::models::task_binding::{TaskBinding, TaskBindingQuery, TaskBindingStatus};
use crate::models::workflow::*;
use crate::repository::WorkflowRepository;
use crate::services::workflow_engine::{self, TaskRef};
use crate::services::TaskBindingService;
use crate::utils::error::{AppError, AppResult};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{info, warn};

/// Metadata key on a child binding pointing back at its workflow task (the receipt).
pub const WORKFLOW_TASK_METADATA_KEY: &str = "workflowTask";

type Waker = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
pub struct DispatchJob {
    pub workflow_id: String,
    pub stage_index: u32,
    pub stage_key: String,
    pub task_key: String,
    pub spec: WorkflowTaskSpec,
    /// Prompt with earlier stage results already substituted.
    pub prompt: String,
}

impl DispatchJob {
    /// Metadata to put on the child binding so recovery can find it.
    pub fn receipt_metadata(&self) -> Value {
        json!({ WORKFLOW_TASK_METADATA_KEY: {
            "workflowId": self.workflow_id,
            "stageIndex": self.stage_index,
            "taskKey": self.task_key,
        }})
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdvanceOutcome {
    pub workflow: Workflow,
    pub jobs: Vec<DispatchJob>,
    pub entered_approval: Option<u32>,
    /// Persisted state changed during this pass.
    pub changed: bool,
}

/// What to do with a task left `claimed` by a crash (docs/114 §6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimRecovery {
    /// No receipt binding: no session can exist, dispatch again.
    Release,
    /// Receipt binding with a session: adopt it, never re-dispatch.
    Adopt(String),
    /// Receipt binding without a session: cannot prove no session started.
    Fail(String),
}

pub fn claim_recovery(receipt: Option<&TaskBinding>) -> ClaimRecovery {
    match receipt {
        None => ClaimRecovery::Release,
        Some(binding) if binding.session_id.as_deref().is_some_and(|s| !s.is_empty()) => {
            ClaimRecovery::Adopt(binding.id.clone())
        }
        Some(binding) => ClaimRecovery::Fail(binding.id.clone()),
    }
}

fn is_receipt_for(binding: &TaskBinding, workflow_id: &str, stage_index: u32, key: &str) -> bool {
    let Some(pointer) = binding
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(WORKFLOW_TASK_METADATA_KEY))
    else {
        return false;
    };
    pointer.get("workflowId").and_then(Value::as_str) == Some(workflow_id)
        && pointer.get("stageIndex").and_then(Value::as_u64) == Some(u64::from(stage_index))
        && pointer.get("taskKey").and_then(Value::as_str) == Some(key)
}

/// Map a child binding to what the reducer needs.
pub fn observe_binding(binding: Option<&TaskBinding>) -> ChildObservation {
    let Some(binding) = binding else {
        return ChildObservation::Missing;
    };
    match binding.status {
        TaskBindingStatus::Completed => ChildObservation::Completed {
            result: binding
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("result"))
                .cloned(),
        },
        TaskBindingStatus::Failed => ChildObservation::Failed {
            reason: binding.completion_summary.clone(),
        },
        _ => ChildObservation::Active,
    }
}

pub struct WorkflowService {
    repo: Arc<WorkflowRepository>,
    waker: parking_lot::RwLock<Option<Waker>>,
}

impl WorkflowService {
    pub fn new(repo: Arc<WorkflowRepository>) -> Self {
        Self {
            repo,
            waker: parking_lot::RwLock::new(None),
        }
    }

    /// The driver installs this to be woken when a workflow may advance.
    pub fn set_waker(&self, waker: Waker) {
        *self.waker.write() = Some(waker);
    }

    pub fn wake(&self, workflow_id: &str) {
        if let Some(waker) = self.waker.read().as_ref().cloned() {
            waker(workflow_id);
        }
    }

    pub fn create(&self, request: CreateWorkflowRequest) -> AppResult<Workflow> {
        workflow_engine::validate_create(&request).map_err(AppError::from)?;
        let now = chrono::Utc::now().to_rfc3339();
        let workflow = workflow_engine::initial_workflow(&request, &now);
        self.repo.insert(&workflow).map_err(AppError::from)?;
        info!(workflow_id = %workflow.id, stages = workflow.stages.len(), "workflow created");
        self.wake(&workflow.id);
        Ok(workflow)
    }

    pub fn get(&self, id: &str) -> AppResult<Option<Workflow>> {
        self.repo.get(id).map_err(AppError::from)
    }

    pub fn list(&self, active_only: bool, limit: u32) -> AppResult<Vec<Workflow>> {
        self.repo
            .list(active_only, limit.clamp(1, 200))
            .map_err(AppError::from)
    }

    /// Approve a stage waiting for approval. Repeating is a no-op.
    pub fn approve_stage(
        &self,
        id: &str,
        selector: StageSelector,
        via: &str,
    ) -> AppResult<Workflow> {
        let mut workflow = self
            .get(id)?
            .ok_or_else(|| AppError::from(format!("workflow '{id}' not found")))?;
        let now = chrono::Utc::now().to_rfc3339();
        let (index, changed) = workflow_engine::approve(&mut workflow, &selector, via, &now)
            .map_err(AppError::from)?;
        if changed {
            self.repo
                .approve(id, index, &now, via)
                .map_err(AppError::from)?;
            info!(workflow_id = %id, stage_index = index, via, "workflow stage approved");
            self.wake(id);
        }
        self.get(id)?
            .ok_or_else(|| AppError::from(format!("workflow '{id}' not found")))
    }

    /// Observe children, reduce, persist and claim what may start now.
    pub fn advance(
        &self,
        id: &str,
        bindings: &TaskBindingService,
    ) -> AppResult<Option<AdvanceOutcome>> {
        let Some(workflow) = self.get(id)? else {
            return Ok(None);
        };
        if workflow.status.is_terminal() {
            return Ok(Some(AdvanceOutcome {
                workflow,
                jobs: Vec::new(),
                entered_approval: None,
                changed: false,
            }));
        }
        if bindings.get(id)?.is_none() {
            return self.fail_orphan(workflow).map(Some);
        }
        let mut observations = HashMap::new();
        for task in workflow.stages.iter().flat_map(|stage| &stage.tasks) {
            if let (WorkflowTaskStatus::Running, Some(binding_id)) =
                (task.status, task.binding_id.as_ref())
            {
                let child = bindings.get(binding_id)?;
                observations.insert(binding_id.clone(), observe_binding(child.as_ref()));
            }
        }
        let reduction = workflow_engine::reduce(workflow.clone(), &observations);
        let changed = reduction.workflow != workflow;
        if changed {
            self.repo
                .save_progress(&reduction.workflow)
                .map_err(AppError::from)?;
        }
        let mut jobs = Vec::new();
        for picked in &reduction.dispatch {
            if let Some(job) = self.claim(&reduction.workflow, picked)? {
                jobs.push(job);
            }
        }
        Ok(Some(AdvanceOutcome {
            workflow: reduction.workflow,
            jobs,
            entered_approval: reduction.entered_approval,
            changed,
        }))
    }

    fn claim(&self, workflow: &Workflow, picked: &TaskRef) -> AppResult<Option<DispatchJob>> {
        if !self
            .repo
            .claim_task(&workflow.id, picked.stage_index, &picked.task_key)
            .map_err(AppError::from)?
        {
            return Ok(None);
        }
        let Some(stage) = workflow.stages.get(picked.stage_index as usize) else {
            return Ok(None);
        };
        let Some(task) = stage.tasks.iter().find(|task| task.key == picked.task_key) else {
            return Ok(None);
        };
        Ok(Some(DispatchJob {
            workflow_id: workflow.id.clone(),
            stage_index: picked.stage_index,
            stage_key: stage.key.clone(),
            task_key: picked.task_key.clone(),
            prompt: workflow_engine::render_prompt(&task.spec.prompt, workflow, picked.stage_index),
            spec: task.spec.clone(),
        }))
    }

    fn fail_orphan(&self, mut workflow: Workflow) -> AppResult<AdvanceOutcome> {
        warn!(workflow_id = %workflow.id, "workflow parent binding deleted; failing workflow");
        workflow.status = WorkflowStatus::Failed;
        if let Some(stage) = workflow
            .stages
            .iter_mut()
            .find(|stage| stage.status != WorkflowStageStatus::Done)
        {
            stage.status = WorkflowStageStatus::Failed;
            stage.error = Some("parent binding deleted".into());
        }
        self.repo.save_progress(&workflow).map_err(AppError::from)?;
        Ok(AdvanceOutcome {
            workflow,
            jobs: Vec::new(),
            entered_approval: None,
            changed: true,
        })
    }

    pub fn dispatch_succeeded(&self, job: &DispatchJob, binding_id: &str) -> AppResult<()> {
        self.settle(job, WorkflowTaskStatus::Running, Some(binding_id), None)?;
        // A very fast child may have finished before it was attached; look again.
        self.wake(&job.workflow_id);
        Ok(())
    }

    pub fn dispatch_failed(&self, job: &DispatchJob, error: &str) -> AppResult<()> {
        self.settle(job, WorkflowTaskStatus::Failed, None, Some(error))?;
        self.wake(&job.workflow_id);
        Ok(())
    }

    fn settle(
        &self,
        job: &DispatchJob,
        status: WorkflowTaskStatus,
        binding_id: Option<&str>,
        error: Option<&str>,
    ) -> AppResult<()> {
        self.repo
            .settle_claim(
                &job.workflow_id,
                job.stage_index,
                &job.task_key,
                status,
                binding_id,
                error,
            )
            .map(|_| ())
            .map_err(AppError::from)
    }

    /// Resolve tasks left `claimed` by a crash. Must run before the driver
    /// dispatches anything in this process. Returns the touched workflow ids.
    pub fn recover_claims(&self, bindings: &TaskBindingService) -> AppResult<Vec<String>> {
        let mut touched = Vec::new();
        for workflow in self.list(true, 200)? {
            let claimed: Vec<(u32, String)> = workflow
                .stages
                .iter()
                .flat_map(|stage| {
                    stage
                        .tasks
                        .iter()
                        .filter(|task| task.status == WorkflowTaskStatus::Claimed)
                        .map(move |task| (stage.index, task.key.clone()))
                })
                .collect();
            if claimed.is_empty() {
                continue;
            }
            let children = children_of(bindings, &workflow.id)?;
            for (stage_index, key) in claimed {
                let receipt = children
                    .iter()
                    .find(|child| is_receipt_for(child, &workflow.id, stage_index, &key));
                self.apply_recovery(&workflow.id, stage_index, &key, claim_recovery(receipt))?;
            }
            touched.push(workflow.id.clone());
        }
        Ok(touched)
    }

    fn apply_recovery(
        &self,
        id: &str,
        stage_index: u32,
        key: &str,
        recovery: ClaimRecovery,
    ) -> AppResult<()> {
        info!(workflow_id = %id, stage_index, task_key = %key, ?recovery, "workflow claim recovery");
        let (status, binding, error) = match &recovery {
            ClaimRecovery::Release => (WorkflowTaskStatus::Pending, None, None),
            ClaimRecovery::Adopt(binding_id) => {
                (WorkflowTaskStatus::Running, Some(binding_id.as_str()), None)
            }
            ClaimRecovery::Fail(binding_id) => (
                WorkflowTaskStatus::Failed,
                Some(binding_id.as_str()),
                Some("interrupted during launch"),
            ),
        };
        self.repo
            .settle_claim(id, stage_index, key, status, binding, error)
            .map(|_| ())
            .map_err(AppError::from)
    }
}

fn children_of(bindings: &TaskBindingService, parent_id: &str) -> AppResult<Vec<TaskBinding>> {
    let mut children = Vec::new();
    let mut offset = 0u32;
    loop {
        let page = bindings.query(TaskBindingQuery {
            parent_id: Some(parent_id.to_string()),
            limit: Some(200),
            offset: Some(offset),
            ..Default::default()
        })?;
        offset += page.items.len() as u32;
        let more = page.has_more && !page.items.is_empty();
        children.extend(page.items);
        if !more {
            return Ok(children);
        }
    }
}

#[cfg(test)]
#[path = "workflow_service_tests.rs"]
mod tests;
