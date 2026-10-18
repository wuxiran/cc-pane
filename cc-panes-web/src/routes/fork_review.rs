use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use cc_panes_core::models::fork_review::*;
use cc_panes_core::utils::AppError;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/fork-reviews", get(list))
        .route("/fork-reviews/prepare", post(prepare))
        .route("/fork-reviews/{id}", get(compare))
        .route("/fork-reviews/{id}/apply", post(apply))
}
fn error(error: AppError) -> (StatusCode, String) {
    let status = match error.code() {
        Some("FORK_CHANGED" | "FORK_CONFLICT" | "FORK_APPLY_BUSY") => StatusCode::CONFLICT,
        Some("FORK_INVALID_REQUEST") => StatusCode::BAD_REQUEST,
        Some("NOT_FOUND") => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_server_failures_and_explicit_client_error_categories() {
        assert_eq!(
            error(AppError::from("Disk full; recovery snapshot: adopt-id")).0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            error(AppError::coded("FORK_INVALID_REQUEST", "Invalid ID")).0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            error(AppError::NotFound("Missing record".into())).0,
            StatusCode::NOT_FOUND
        );
        for code in ["FORK_CHANGED", "FORK_CONFLICT", "FORK_APPLY_BUSY"] {
            assert_eq!(
                error(AppError::coded(code, "Conflict")).0,
                StatusCode::CONFLICT
            );
        }
    }
}
fn join(error: tokio::task::JoinError) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}
pub async fn prepare(
    State(state): State<AppState>,
    Json(request): Json<PrepareChatForkRequest>,
) -> Result<Json<PreparedChatFork>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || state.fork_review_service.prepare(request))
        .await
        .map_err(join)?
        .map(Json)
        .map_err(error)
}
pub async fn list(
    State(state): State<AppState>,
) -> Result<Json<Vec<ForkReviewRecord>>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || state.fork_review_service.list())
        .await
        .map_err(join)?
        .map(Json)
        .map_err(error)
}
pub async fn compare(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ForkComparison>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || state.fork_review_service.compare(&id))
        .await
        .map_err(join)?
        .map(Json)
        .map_err(error)
}
pub async fn apply(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<ApplyForkChangesRequest>,
) -> Result<Json<ApplyForkChangesResult>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || state.fork_review_service.apply(&id, request))
        .await
        .map_err(join)?
        .map(Json)
        .map_err(error)
}
