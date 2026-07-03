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
            "error": self.0.message(),
            "code": self.0.code(),
        });
        (status, axum::Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn response_json(err: ApiError) -> (StatusCode, serde_json::Value) {
        let response = err.into_response();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should collect");
        let json = serde_json::from_slice(&bytes).expect("body should be JSON");
        (status, json)
    }

    #[test]
    fn from_app_error_wraps_without_change() {
        let api_err = ApiError::from(AppError::coded("SOME_CODE", "boom"));
        assert_eq!(api_err.0.code(), Some("SOME_CODE"));
        assert_eq!(api_err.0.message(), "boom");
    }

    #[tokio::test]
    async fn coded_error_maps_to_500_with_code_and_message() {
        let (status, json) =
            response_json(ApiError(AppError::coded("WS_NOT_FOUND", "missing"))).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(json["error"], "missing");
        assert_eq!(json["code"], "WS_NOT_FOUND");
    }

    #[tokio::test]
    async fn plain_message_error_has_null_code() {
        let (status, json) = response_json(ApiError(AppError::from("plain failure"))).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(json["error"], "plain failure");
        assert!(json["code"].is_null());
    }

    #[tokio::test]
    async fn not_found_error_uses_not_found_code() {
        let (_, json) = response_json(ApiError(AppError::NotFound("gone".to_string()))).await;
        assert_eq!(json["error"], "gone");
        assert_eq!(json["code"], "NOT_FOUND");
    }
}
