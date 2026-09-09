use crate::services::performance_recorder::{
    DiagnosticEvent, EventKind, FrontendSnapshot, PerformanceRecorder, RecorderStatus,
};
use crate::utils::{AppError, AppResult};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn record_performance_snapshot(
    service: State<'_, Arc<PerformanceRecorder>>,
    snapshot: FrontendSnapshot,
) -> AppResult<()> {
    service.update_frontend(snapshot).map_err(AppError::from)
}

#[tauri::command]
pub fn get_performance_recorder_status(
    service: State<'_, Arc<PerformanceRecorder>>,
) -> RecorderStatus {
    service.status()
}

#[tauri::command]
pub fn mark_performance_incident(service: State<'_, Arc<PerformanceRecorder>>) -> AppResult<()> {
    let status = service.status();
    if !status.running || status.last_error.is_some() {
        return Err(AppError::from(
            "Performance recorder is unavailable; check its status",
        ));
    }
    if !service.record_event(DiagnosticEvent {
        kind: EventKind::ManualMarker,
        session_id: None,
        end_seq: None,
    }) {
        return Err(AppError::from(
            "Performance event queue is busy; marker was not saved",
        ));
    }
    Ok(())
}
