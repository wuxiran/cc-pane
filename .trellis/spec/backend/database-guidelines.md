# Database Guidelines (CC-Panes)

> SQLite + rusqlite 使用规范

---

## Connection Management

```rust
// 使用 Arc<Mutex<Connection>> 共享连接
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn new(path: &str) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    /// 测试用内存数据库
    pub fn in_memory() -> AppResult<Self> {
        Self::new(":memory:")
    }
}
```

---

## Query Patterns

### 参数化查询（防 SQL 注入）

```rust
// GOOD: 参数化
conn.query_row(
    "SELECT * FROM projects WHERE id = ?1",
    params![id],
    |row| Ok(Project { /* ... */ }),
)?;

// BAD: 字符串拼接
conn.query_row(
    &format!("SELECT * FROM projects WHERE id = '{}'", id),
    [],
    |row| Ok(Project { /* ... */ }),
)?;
```

### CRUD 模板

```rust
// Create
conn.execute(
    "INSERT INTO projects (id, name, path) VALUES (?1, ?2, ?3)",
    params![project.id, project.name, project.path],
)?;

// Read (single)
conn.query_row("SELECT ... WHERE id = ?1", params![id], mapper)?;

// Read (list)
let mut stmt = conn.prepare("SELECT ... WHERE workspace_id = ?1")?;
let rows = stmt.query_map(params![workspace_id], mapper)?;
rows.collect::<Result<Vec<_>, _>>()?;

// Update
conn.execute("UPDATE projects SET name = ?2 WHERE id = ?1", params![id, name])?;

// Delete
conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
```

---

## Schema Management

- 表结构在 `repository/db.rs` 中用 `CREATE TABLE IF NOT EXISTS` 初始化
- 版本迁移通过 `PRAGMA user_version` 管理
- 所有 ID 使用 UUID 字符串

---

## Testing

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Database {
        let db = Database::in_memory().unwrap();
        db.initialize_tables().unwrap();
        db
    }

    #[test]
    fn test_create_and_find() {
        let db = setup_test_db();
        // ... test CRUD
    }
}
```

---

## Forbidden

- 字符串拼接 SQL（必须参数化）
- 在 Service 层直接写 SQL（放 Repository）
- 不检查 `execute()` 返回的影响行数
