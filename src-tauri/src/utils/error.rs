use serde::Serialize;

/// 统一应用错误类型，替代 `Result<T, String>` + `.map_err(|e| e.to_string())`
#[derive(Debug, Serialize)]
pub struct AppError {
    pub message: String,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        Self {
            message: err.to_string(),
        }
    }
}

impl From<String> for AppError {
    fn from(msg: String) -> Self {
        Self { message: msg }
    }
}

impl From<&str> for AppError {
    fn from(msg: &str) -> Self {
        Self {
            message: msg.to_string(),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self {
            message: err.to_string(),
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        Self {
            message: err.to_string(),
        }
    }
}

impl From<tauri::Error> for AppError {
    fn from(err: tauri::Error) -> Self {
        Self {
            message: err.to_string(),
        }
    }
}

/// 统一结果类型
pub type AppResult<T> = Result<T, AppError>;
