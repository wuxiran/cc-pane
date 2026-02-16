# Error Handling (CC-Panes)

> AppResult<T> + AppError 统一错误处理

---

## Core Types

```rust
// src-tauri/src/utils/error.rs

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("{0}")]
    Custom(String),
}

// Tauri 命令需要 Into<String> 来序列化错误
impl From<AppError> for String {
    fn from(err: AppError) -> String {
        err.to_string()
    }
}
```

---

## Usage Patterns

### Command Layer

```rust
#[tauri::command]
async fn get_project(
    id: String,
    service: State<'_, Arc<ProjectService>>,
) -> Result<Project, String> {
    service.get_by_id(&id).map_err(|e| e.to_string())
}
```

### Service Layer

```rust
impl ProjectService {
    pub fn get_by_id(&self, id: &str) -> AppResult<Project> {
        self.repo.find_by_id(id)?
            .ok_or_else(|| AppError::NotFound(format!("Project {id}")))
    }
}
```

### Repository Layer

```rust
impl ProjectRepo {
    pub fn find_by_id(&self, id: &str) -> AppResult<Option<Project>> {
        let conn = self.db.lock().map_err(|e| AppError::Database(e.to_string()))?;
        // ... SQL query
        Ok(project)
    }
}
```

---

## Key Rules

1. **Service 返回 `AppResult<T>`**: 不要返回 `Result<T, String>`
2. **Command 层转换错误**: `.map_err(|e| e.to_string())` 将 AppError 转为 String
3. **使用 `?` 传播**: 配合 `#[from]` 自动转换标准库错误
4. **不要 unwrap()**: 除非在测试代码中

---

## Forbidden

- `unwrap()` / `expect()` 在生产代码中
- 在 command 层捕获并 swallow 错误
- 错误消息中泄露数据库结构或内部路径
