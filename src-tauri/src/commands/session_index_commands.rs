use crate::utils::AppResult;
use cc_panes_core::models::{
    SessionIndexEntry, SessionIndexListParams, SessionIndexQuery, SessionIndexScanReport,
};
use cc_panes_core::services::SessionIndexService;
use std::sync::Arc;
use tauri::State;

fn session_index_query(params: SessionIndexListParams) -> AppResult<SessionIndexQuery> {
    params.into_query().map_err(Into::into)
}

#[tauri::command]
pub fn list_session_index(
    service: State<'_, Arc<SessionIndexService>>,
    params: SessionIndexListParams,
) -> AppResult<Vec<SessionIndexEntry>> {
    service.list_sessions(session_index_query(params)?)
}

#[tauri::command]
pub async fn refresh_session_index(
    service: State<'_, Arc<SessionIndexService>>,
) -> AppResult<SessionIndexScanReport> {
    service.inner().clone().refresh_session_index().await
}

#[tauri::command]
pub fn check_codex_rollout_exists(
    service: State<'_, Arc<SessionIndexService>>,
    session_id: String,
    wsl_distro: Option<String>,
) -> Option<bool> {
    service.codex_rollout_exists(&session_id, wsl_distro.as_deref())
}

#[cfg(test)]
mod tests {
    use super::session_index_query;
    use cc_panes_core::models::{SessionIndexListParams, SessionIndexScope};

    #[test]
    fn tauri_session_index_args_map_to_shared_query_params() {
        let query = session_index_query(SessionIndexListParams {
            scope: Some("project".to_string()),
            workspace_name: None,
            project_path: Some(" D:\\repo ".to_string()),
            query: Some(" search ".to_string()),
            cli_filter: Some("codex".to_string()),
            limit: Some(20),
            offset: Some(40),
        })
        .expect("project query");

        assert_eq!(
            query.scope,
            SessionIndexScope::Project("D:\\repo".to_string())
        );
        assert_eq!(query.query.as_deref(), Some("search"));
        assert_eq!(query.cli_filter.as_deref(), Some("codex"));
        assert_eq!((query.limit, query.offset), (20, 40));
    }
}
