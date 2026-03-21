//! HTTP error conversion
//!
//! Converts cc-panes-core AppError into axum HTTP responses.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use cc_panes_core::utils::error::AppError;

/// Newtype wrapper around AppError for implementing IntoResponse
pub struct ApiError(pub AppError);

impl From<AppError> for ApiError {
    fn from(err: AppError) -> Self {
        Self(err)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::INTERNAL_SERVER_ERROR;
        let body = serde_json::json!({
            "error": self.0.message,
            "code": self.0.code,
        });
        (status, axum::Json(body)).into_response()
    }
}
