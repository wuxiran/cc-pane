use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use cc_panes_core::models::task_verification::{
    RunTaskVerificationRequest, TaskVerificationReport,
};
use cc_panes_core::utils::AppError;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/task-bindings/{id}/verification", get(list))
        .route("/task-bindings/{id}/verification/run", post(run))
}

fn service_error(error: AppError) -> (StatusCode, String) {
    let status = match error.code() {
        Some("VERIFICATION_INVALID_REQUEST") => StatusCode::BAD_REQUEST,
        Some("NOT_FOUND") => StatusCode::NOT_FOUND,
        Some("VERIFICATION_RUNNING") => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string())
}

pub async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<TaskVerificationReport>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || state.task_verification_service.list(&id))
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
        .map_err(service_error)
}

pub async fn run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<RunTaskVerificationRequest>,
) -> Result<Json<TaskVerificationReport>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || state.task_verification_service.run(&id, request))
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
        .map_err(service_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_known_request_errors_to_client_statuses() {
        for (code, expected) in [
            ("VERIFICATION_INVALID_REQUEST", StatusCode::BAD_REQUEST),
            ("NOT_FOUND", StatusCode::NOT_FOUND),
            ("VERIFICATION_RUNNING", StatusCode::CONFLICT),
        ] {
            assert_eq!(service_error(AppError::coded(code, "expected")).0, expected);
        }
    }

    #[test]
    fn preserves_io_failures_as_server_errors() {
        let error = AppError::from(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "evidence directory unavailable",
        ));
        let (status, message) = service_error(error);
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(message.contains("evidence directory unavailable"));
    }

    #[test]
    fn unknown_codes_and_uncoded_failures_are_server_errors() {
        assert_eq!(
            service_error(AppError::coded("OTHER_FAILURE", "failure")).0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            service_error(AppError::from("snapshot failed")).0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
