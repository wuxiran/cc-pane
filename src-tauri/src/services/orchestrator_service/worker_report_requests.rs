//! Shared production entry points for durable updates and explicit worker reports.
//! Both MCP handlers use these paths, so regression tests exercise persistence,
//! automatic notification, payload overrides and delivery together.
use super::*;

pub(super) fn update_binding_and_notify(
    runtime: ReportRuntime,
    id: &str,
    request: UpdateTaskBindingRequest,
) -> cc_panes_core::utils::AppResult<TaskBinding> {
    let (old_revision, binding) = runtime
        .task_binding_service
        .update_returning_previous_report_revision(id, request)?;
    if old_revision != Some(binding.report_revision)
        && matches!(
            binding.status,
            TaskBindingStatus::Completed | TaskBindingStatus::Failed
        )
    {
        let worker = binding.clone();
        tokio::spawn(async move {
            let _ = send_worker_report_to_leader_with_attempt(runtime, worker, 0).await;
        });
    }
    Ok(binding)
}

pub(super) async fn report(
    runtime: ReportRuntime,
    params: McpReportToLeaderParams,
) -> LeaderReportResult {
    let mut worker = match runtime.task_binding_service.get(&params.worker_id) {
        Ok(Some(binding)) => binding,
        Ok(None) => return LeaderReportResult::skipped("worker not found"),
        Err(error) => {
            return LeaderReportResult::skipped(format!("failed to load worker: {error}"))
        }
    };
    if let Some(status) = params.status {
        match status.parse::<TaskBindingStatus>() {
            Ok(status) => worker.status = status,
            Err(error) => return LeaderReportResult::skipped(format!("invalid status: {error}")),
        }
    }
    if let Some(summary) = params.summary {
        worker.completion_summary = Some(summary);
    }
    send_worker_report_to_leader_with_attempt(runtime, worker, 0).await
}
