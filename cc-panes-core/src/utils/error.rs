use serde::Serialize;
use std::collections::HashMap;

/// 统一应用错误类型
///
/// 支持两种模式：
/// - 简单错误：仅 message（兼容旧代码）
/// - 结构化错误：code + message + params（前端可通过 i18n 翻译）
///
/// 前端 `translateError()` 会读取 `code` 字段查找 i18n 翻译，
/// `params` 用于翻译模板中的插值（如 `{{name}}`、`{{path}}`）。
#[derive(Debug, Serialize)]
pub struct AppError {
    /// 错误码，对应前端 `errors.json` 中的 key（如 "WORKSPACE_NOT_FOUND"）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,

    /// 错误消息（开发调试用，前端优先使用 code 对应的 i18n 翻译）
    pub message: String,

    /// i18n 插值参数（如 `{ "name": "my-workspace" }`）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<HashMap<String, String>>,
}

impl AppError {
    /// 创建带错误码的结构化错误
    pub fn coded(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: Some(code.to_string()),
            message: message.into(),
            params: None,
        }
    }

    /// 创建带错误码和 i18n 参数的结构化错误
    pub fn coded_with_params(
        code: &str,
        message: impl Into<String>,
        params: HashMap<String, String>,
    ) -> Self {
        Self {
            code: Some(code.to_string()),
            message: message.into(),
            params: Some(params),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(ref code) = self.code {
            write!(f, "[{}] {}", code, self.message)
        } else {
            write!(f, "{}", self.message)
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        Self {
            code: None,
            message: err.to_string(),
            params: None,
        }
    }
}

impl From<String> for AppError {
    fn from(msg: String) -> Self {
        Self {
            code: None,
            message: msg,
            params: None,
        }
    }
}

impl From<&str> for AppError {
    fn from(msg: &str) -> Self {
        Self {
            code: None,
            message: msg.to_string(),
            params: None,
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self {
            code: None,
            message: err.to_string(),
            params: None,
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        Self {
            code: None,
            message: err.to_string(),
            params: None,
        }
    }
}

/// 统一结果类型
pub type AppResult<T> = Result<T, AppError>;
