//! Staged workflows (docs/114): desktop list + approval.
use crate::utils::AppResult;
use cc_panes_core::models::workflow::{StageSelector, Workflow};
use cc_panes_core::services::WorkflowService;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn list_workflows(
    service: State<'_, Arc<WorkflowService>>,
    active_only: Option<bool>,
) -> AppResult<Vec<Workflow>> {
    service.list(active_only.unwrap_or(false), 100)
}

#[tauri::command]
pub fn approve_workflow_stage(
    service: State<'_, Arc<WorkflowService>>,
    workflow_id: String,
    stage_index: u32,
) -> AppResult<Workflow> {
    service.approve_stage(&workflow_id, StageSelector::Index(stage_index), "desktop")
}
