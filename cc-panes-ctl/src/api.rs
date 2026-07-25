use std::fmt;
use std::time::Duration;

use serde_json::Value;

use crate::discovery::ServiceEndpoint;

const RESPONSE_LIMIT: u64 = 24 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiErrorKind {
    Unreachable,
    Http(u16),
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub kind: ApiErrorKind,
    message: String,
}

impl ApiError {
    fn new(kind: ApiErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {}

#[derive(Debug, Clone)]
pub struct ApiClient {
    endpoint: ServiceEndpoint,
    timeout: Duration,
}

impl ApiClient {
    pub fn new(endpoint: ServiceEndpoint) -> Self {
        Self {
            endpoint,
            timeout: Duration::from_secs(10),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn endpoint(&self) -> &ServiceEndpoint {
        &self.endpoint
    }

    pub fn get_json(&self, path: &str) -> Result<Value, ApiError> {
        let response = self
            .agent()
            .get(&self.url(path)?)
            .header("Authorization", &format!("Bearer {}", self.endpoint.token))
            .call()
            .map_err(transport_error)?;
        decode_response(response)
    }

    pub fn post_json(&self, path: &str, body: &Value) -> Result<Value, ApiError> {
        let payload = serde_json::to_vec(body).map_err(|error| {
            ApiError::new(
                ApiErrorKind::InvalidResponse,
                format!("编码 REST 请求失败: {error}"),
            )
        })?;
        let response = self
            .agent()
            .post(&self.url(path)?)
            .header("Authorization", &format!("Bearer {}", self.endpoint.token))
            .header("Content-Type", "application/json")
            .send(payload.as_slice())
            .map_err(transport_error)?;
        decode_response(response)
    }

    pub fn delete_json(&self, path: &str) -> Result<Value, ApiError> {
        let response = self
            .agent()
            .delete(&self.url(path)?)
            .header("Authorization", &format!("Bearer {}", self.endpoint.token))
            .call()
            .map_err(transport_error)?;
        decode_response(response)
    }

    fn agent(&self) -> ureq::Agent {
        ureq::Agent::config_builder()
            .timeout_global(Some(self.timeout))
            .http_status_as_error(false)
            .build()
            .new_agent()
    }

    fn url(&self, path: &str) -> Result<String, ApiError> {
        if !path.starts_with('/') {
            return Err(ApiError::new(
                ApiErrorKind::InvalidResponse,
                "REST path 必须以 '/' 开头",
            ));
        }
        Ok(format!(
            "{}{}",
            self.endpoint.base_url.trim_end_matches('/'),
            path
        ))
    }
}

pub fn path_with_segment(prefix: &[&str], segment: &str, suffix: &[&str]) -> String {
    let mut url = url::Url::parse("http://localhost").expect("static URL");
    {
        let mut segments = url.path_segments_mut().expect("base URL");
        segments.clear();
        segments.extend(prefix.iter().copied());
        segments.push(segment);
        segments.extend(suffix.iter().copied());
    }
    url.path().to_string()
}

fn decode_response(mut response: ureq::http::Response<ureq::Body>) -> Result<Value, ApiError> {
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(RESPONSE_LIMIT)
        .read_to_string()
        .map_err(|error| {
            ApiError::new(
                ApiErrorKind::InvalidResponse,
                format!("读取 REST 响应失败: {error}"),
            )
        })?;
    if !(200..300).contains(&status) {
        return Err(ApiError::new(
            ApiErrorKind::Http(status),
            format!("REST HTTP {status}: {}", compact_text(&body)),
        ));
    }
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&body).map_err(|error| {
        ApiError::new(
            ApiErrorKind::InvalidResponse,
            format!("REST JSON 响应无效: {error}"),
        )
    })
}

fn transport_error(error: ureq::Error) -> ApiError {
    ApiError::new(ApiErrorKind::Unreachable, format!("REST 源不可达: {error}"))
}

fn compact_text(value: &str) -> String {
    const LIMIT: usize = 512;
    let mut text = value.chars().take(LIMIT).collect::<String>();
    if value.chars().count() > LIMIT {
        text.push_str("...");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segment_is_percent_encoded() {
        assert_eq!(
            path_with_segment(&["api", "sessions"], "a/b c", &["output"]),
            "/api/sessions/a%2Fb%20c/output"
        );
    }
}
