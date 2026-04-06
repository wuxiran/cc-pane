use crate::utils::error::AppError;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tracing::{error, info, warn};

/// 单条迁移定义
struct Migration {
    version: i64,
    description: &'static str,
    up_sql: &'static str,
}

/// 版本化迁移列表（仅追加，不可修改已有项）
///
/// V1 = 初始表结构（projects + launch_history + todos + todo_subtasks）
/// V2 = launch_history 添加 claude_session_id / last_prompt / workspace_name / workspace_path / launch_cwd
/// V3 = todos 添加 my_day / my_day_date / reminder_at / recurrence
/// V4 = todos 添加 todo_type
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        description: "initial tables: projects, launch_history, todos, todo_subtasks",
        up_sql: "
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                alias TEXT
            );

            CREATE TABLE IF NOT EXISTS launch_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                project_name TEXT NOT NULL,
                project_path TEXT NOT NULL,
                launched_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS todos (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'todo',
                priority TEXT NOT NULL DEFAULT 'medium',
                scope TEXT NOT NULL DEFAULT 'global',
                scope_ref TEXT,
                tags TEXT DEFAULT '[]',
                due_date TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS todo_subtasks (
                id TEXT PRIMARY KEY,
                todo_id TEXT NOT NULL,
                title TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
            );
        ",
    },
    Migration {
        version: 2,
        description: "launch_history: add claude_session_id, last_prompt, workspace_name, workspace_path, launch_cwd",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN claude_session_id TEXT;
            ALTER TABLE launch_history ADD COLUMN last_prompt TEXT;
            ALTER TABLE launch_history ADD COLUMN workspace_name TEXT;
            ALTER TABLE launch_history ADD COLUMN workspace_path TEXT;
            ALTER TABLE launch_history ADD COLUMN launch_cwd TEXT;
        ",
    },
    Migration {
        version: 3,
        description: "todos: add my_day, my_day_date, reminder_at, recurrence",
        up_sql: "
            ALTER TABLE todos ADD COLUMN my_day INTEGER DEFAULT 0;
            ALTER TABLE todos ADD COLUMN my_day_date TEXT;
            ALTER TABLE todos ADD COLUMN reminder_at TEXT;
            ALTER TABLE todos ADD COLUMN recurrence TEXT;
        ",
    },
    Migration {
        version: 4,
        description: "todos: add todo_type",
        up_sql: "
            ALTER TABLE todos ADD COLUMN todo_type TEXT DEFAULT '';
        ",
    },
    Migration {
        version: 5,
        description: "specs: create specs table",
        up_sql: "
            CREATE TABLE IF NOT EXISTS specs (
                id TEXT PRIMARY KEY,
                project_path TEXT NOT NULL,
                title TEXT NOT NULL,
                file_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                todo_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                archived_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_specs_project_path ON specs(project_path);
            CREATE INDEX IF NOT EXISTS idx_specs_status ON specs(project_path, status);
        ",
    },
    Migration {
        version: 6,
        description: "launch_history: add provider_id",
        up_sql: "
            ALTER TABLE launch_history ADD COLUMN provider_id TEXT;
        ",
    },
    Migration {
        version: 7,
        description: "terminal_sessions: session restore support",
        up_sql: "
            CREATE TABLE IF NOT EXISTS terminal_sessions (
                session_id TEXT PRIMARY KEY,
                tab_id TEXT NOT NULL,
                pane_id TEXT NOT NULL,
                project_path TEXT NOT NULL,
                workspace_name TEXT,
                workspace_path TEXT,
                provider_id TEXT,
                cli_tool TEXT NOT NULL DEFAULT 'none',
                resume_id TEXT,
                claude_session_id TEXT,
                ssh_config TEXT,
                custom_title TEXT,
                created_at TEXT NOT NULL,
                saved_at TEXT NOT NULL
            );
        ",
    },
    Migration {
        version: 8,
        description: "task_bindings: orchestration task binding support",
        up_sql: "
            CREATE TABLE IF NOT EXISTS task_bindings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                prompt TEXT,
                session_id TEXT,
                todo_id TEXT,
                project_path TEXT NOT NULL,
                workspace_name TEXT,
                cli_tool TEXT NOT NULL DEFAULT 'claude',
                status TEXT NOT NULL DEFAULT 'pending',
                progress INTEGER NOT NULL DEFAULT 0,
                completion_summary TEXT,
                exit_code INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_task_bindings_status ON task_bindings(status);
            CREATE INDEX IF NOT EXISTS idx_task_bindings_project ON task_bindings(project_path);
            CREATE INDEX IF NOT EXISTS idx_task_bindings_session ON task_bindings(session_id);
        ",
    },
];

/// 数据库连接管理
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// 创建新的数据库连接
    pub fn new(db_path: PathBuf) -> Result<Self, AppError> {
        // 确保目录存在
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                error!(path = %parent.display(), err = %e, "Failed to create database directory");
                AppError::from(format!("Failed to create database directory: {}", e))
            })?;
        }

        let conn = Connection::open(&db_path).map_err(|e| {
            error!(path = %db_path.display(), err = %e, "Failed to open database");
            AppError::from(format!("Failed to open database: {}", e))
        })?;

        // WAL 模式：提升读写并发性能，减少写锁等待。
        // `journal_mode` pragma 会返回结果行，必须通过 query_row 读取。
        conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| {
            error!(err = %e, "Failed to enable WAL mode");
            AppError::from(format!("Failed to enable WAL mode: {}", e))
        })?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| {
                error!(err = %e, "Failed to set synchronous pragma");
                AppError::from(format!("Failed to set synchronous pragma: {}", e))
            })?;
        conn.busy_timeout(Duration::from_millis(5000))
            .map_err(|e| {
                error!(err = %e, "Failed to set busy timeout");
                AppError::from(format!("Failed to set busy timeout: {}", e))
            })?;

        Self::run_migrations(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 降级到内存数据库（磁盘数据库失败时的 fallback）
    pub fn new_fallback() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory().map_err(|e| {
            error!(err = %e, "Failed to create fallback in-memory database");
            AppError::from(format!(
                "Failed to create fallback in-memory database: {}",
                e
            ))
        })?;
        Self::run_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 执行版本化数据库迁移
    fn run_migrations(conn: &Connection) -> Result<(), AppError> {
        // 确保 schema_migrations 表存在
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );"
        )
        .map_err(|e| {
            error!(table = "schema_migrations", err = %e, "Failed to create schema_migrations table");
            AppError::from(format!("Failed to create schema_migrations table: {}", e))
        })?;

        let current_version = Self::get_current_version(conn)?;
        let pending: Vec<&Migration> = MIGRATIONS
            .iter()
            .filter(|m| m.version > current_version)
            .collect();

        if pending.is_empty() {
            info!(
                "Database schema is up to date (version {})",
                current_version
            );
            return Ok(());
        }

        info!(
            "Running {} pending migration(s) (current: v{}, target: v{})",
            pending.len(),
            current_version,
            pending.last().map(|m| m.version).unwrap_or(current_version),
        );

        for migration in pending {
            info!(
                "Applying migration v{}: {}",
                migration.version, migration.description
            );

            // 每条迁移在一个事务内执行，保证原子性
            let tx = conn.unchecked_transaction()
                .map_err(|e| {
                    error!(version = migration.version, err = %e, "Failed to begin transaction for migration");
                    AppError::from(format!("Failed to begin transaction for migration v{}: {}", migration.version, e))
                })?;

            // execute_batch 不支持事务内参数绑定，但对 DDL 语句足够
            // 对 ALTER TABLE 的 "duplicate column" 错误做容错处理（兼容旧数据库）
            match tx.execute_batch(migration.up_sql) {
                Ok(()) => {}
                Err(e) => {
                    let err_msg = e.to_string();
                    // SQLite 的 ALTER TABLE ADD COLUMN 对已存在列报 "duplicate column name"
                    if err_msg.contains("duplicate column name") {
                        warn!(
                            "Migration v{} encountered duplicate column (already applied partially), continuing",
                            migration.version
                        );
                    } else {
                        return Err(AppError::from(format!(
                            "Migration v{} failed: {}",
                            migration.version, e
                        )));
                    }
                }
            }

            tx.execute(
                "INSERT OR REPLACE INTO schema_migrations (version, description) VALUES (?1, ?2)",
                rusqlite::params![migration.version, migration.description],
            )
            .map_err(|e| {
                error!(table = "schema_migrations", version = migration.version, err = %e, "Failed to record migration");
                AppError::from(format!(
                    "Failed to record migration v{}: {}",
                    migration.version, e
                ))
            })?;

            tx.commit().map_err(|e| {
                error!(version = migration.version, err = %e, "Failed to commit migration");
                AppError::from(format!(
                    "Failed to commit migration v{}: {}",
                    migration.version, e
                ))
            })?;

            info!("Migration v{} applied successfully", migration.version);
        }

        Ok(())
    }

    /// 获取当前数据库版本号（0 表示全新数据库）
    fn get_current_version(conn: &Connection) -> Result<i64, AppError> {
        let version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .map_err(|e| {
                error!(table = "schema_migrations", err = %e, "Failed to query schema version");
                AppError::from(format!("Failed to query schema version: {}", e))
            })?;
        Ok(version)
    }

    /// 创建内存数据库（用于测试）
    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, AppError> {
        Self::new_fallback()
    }

    /// 获取数据库连接的可变引用
    pub fn connection(&self) -> Result<MutexGuard<'_, Connection>, AppError> {
        self.conn.lock().map_err(|_| {
            error!("Database lock poisoned");
            AppError::from("Database lock poisoned")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fresh_database_migrates_to_latest() {
        let db = Database::new_in_memory().expect("should create in-memory db");
        let conn = db.connection().expect("should get connection");
        let version = Database::get_current_version(&conn).expect("should get version");
        assert_eq!(version, MIGRATIONS.last().unwrap().version);
    }

    #[test]
    fn test_migrations_are_idempotent() {
        let db = Database::new_in_memory().expect("first init");
        // 再次运行迁移应该不报错
        let conn = db.connection().expect("connection");
        Database::run_migrations(&conn).expect("second migration run should succeed");
    }

    #[test]
    fn test_schema_migrations_table_records_all_versions() {
        let db = Database::new_in_memory().expect("should create db");
        let conn = db.connection().expect("should get connection");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("should count migrations");
        assert_eq!(count, MIGRATIONS.len() as i64);
    }

    #[test]
    fn test_all_tables_exist_after_migration() {
        let db = Database::new_in_memory().expect("should create db");
        let conn = db.connection().expect("should get connection");

        let tables = [
            "projects",
            "launch_history",
            "todos",
            "todo_subtasks",
            "specs",
            "terminal_sessions",
            "schema_migrations",
        ];
        for table in &tables {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            assert!(exists, "Table '{}' should exist", table);
        }
    }
}
