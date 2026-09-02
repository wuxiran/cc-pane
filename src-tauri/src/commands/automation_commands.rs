//! Automations（定时派 ACP agent）的 Tauri 命令面。

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::services::{AutomationDef, AutomationRun, AutomationService};
use crate::utils::AppResult;

#[tauri::command]
pub async fn list_automations(
    service: State<'_, Arc<AutomationService>>,
) -> AppResult<Vec<AutomationDef>> {
    Ok(service.list())
}

#[tauri::command]
pub async fn save_automation(
    service: State<'_, Arc<AutomationService>>,
    def: AutomationDef,
) -> AppResult<AutomationDef> {
    service.save(def)
}

#[tauri::command]
pub async fn delete_automation(
    service: State<'_, Arc<AutomationService>>,
    automation_id: String,
) -> AppResult<()> {
    service.delete(&automation_id)
}

#[tauri::command]
pub async fn run_automation_now(
    app: AppHandle,
    service: State<'_, Arc<AutomationService>>,
    automation_id: String,
) -> AppResult<()> {
    service.run_now(app, &automation_id).await
}

#[tauri::command]
pub async fn list_automation_runs(
    service: State<'_, Arc<AutomationService>>,
    automation_id: String,
) -> AppResult<Vec<AutomationRun>> {
    Ok(service.runs(&automation_id))
}
