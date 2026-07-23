use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use std::collections::HashMap;

/// 统一应用错误类型
///
/// 支持两种模式：
/// - 简单错误：仅 message（兼容旧代码）
/// - 结构化错误：code + message + params（前端可通过 i18n 翻译）
///
/// 前端 `translateError()` 会读取 `code` 字段查找 i18n 翻译，
/// `params` 用于翻译模板中的插值（如 `{{name}}`、`{{path}}`）。
#[derive(Debug, Clone)]
pub enum AppError {
    Message {
        /// 错误码，对应前端 `errors.json` 中的 key（如 "WORKSPACE_NOT_FOUND"）
        code: Option<String>,
        /// 错误消息（开发调试用，前端优先使用 code 对应的 i18n 翻译）
        message: String,
        /// i18n 插值参数（如 `{ "name": "my-workspace" }`）
        params: Option<HashMap<String, String>>,
    },
    NotFound(String),
}

impl AppError {
    fn message_error(
        code: Option<String>,
        message: impl Into<String>,
        params: Option<HashMap<String, String>>,
    ) -> Self {
        Self::Message {
            code,
            message: message.into(),
            params,
        }
    }

    /// 创建带错误码的结构化错误
    pub fn coded(code: &str, message: impl Into<String>) -> Self {
        Self::message_error(Some(code.to_string()), message, None)
    }

    /// 创建带错误码和 i18n 参数的结构化错误
    pub fn coded_with_params(
        code: &str,
        message: impl Into<String>,
        params: HashMap<String, String>,
    ) -> Self {
        Self::message_error(Some(code.to_string()), message, Some(params))
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Message { code, .. } => code.as_deref(),
            Self::NotFound(_) => Some("NOT_FOUND"),
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Message { message, .. } => message,
            Self::NotFound(message) => message,
        }
    }

    pub fn params(&self) -> Option<&HashMap<String, String>> {
        match self {
            Self::Message { params, .. } => params.as_ref(),
            Self::NotFound(_) => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        if let Some(code) = self.code() {
            map.serialize_entry("code", code)?;
        }
        map.serialize_entry("message", self.message())?;
        if let Some(params) = self.params() {
            map.serialize_entry("params", params)?;
        }
        map.end()
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(code) = self.code() {
            write!(f, "[{}] {}", code, self.message())
        } else {
            write!(f, "{}", self.message())
        }
    }
}

impl std::error::Error for AppError {}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        Self::message_error(None, err.to_string(), None)
    }
}

impl From<String> for AppError {
    fn from(msg: String) -> Self {
        Self::message_error(None, msg, None)
    }
}

impl From<&str> for AppError {
    fn from(msg: &str) -> Self {
        Self::message_error(None, msg, None)
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::message_error(None, err.to_string(), None)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        Self::message_error(None, err.to_string(), None)
    }
}

/// 统一结果类型
pub type AppResult<T> = Result<T, AppError>;
