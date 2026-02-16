use crate::utils::error::AppError;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

/// 数据库连接管理
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// 创建新的数据库连接
    pub fn new(db_path: PathBuf) -> Result<Self, AppError> {
        // 确保目录存在
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::from(format!("无法创建数据库目录: {}", e)))?;
        }

        let conn = Connection::open(&db_path)
            .map_err(|e| AppError::from(format!("无法打开数据库: {}", e)))?;
        Self::init_tables(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 初始化数据库表结构
    fn init_tables(conn: &Connection) -> Result<(), AppError> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                alias TEXT
            )",
            [],
        )
        .map_err(|e| AppError::from(format!("无法创建 projects 表: {}", e)))?;

        // 迁移：为旧表添加 alias 字段
        let _ = conn.execute("ALTER TABLE projects ADD COLUMN alias TEXT", []);

        conn.execute(
            "CREATE TABLE IF NOT EXISTS launch_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                project_name TEXT NOT NULL,
                project_path TEXT NOT NULL,
                launched_at TEXT NOT NULL
            )",
            [],
        )
        .map_err(|e| AppError::from(format!("无法创建 launch_history 表: {}", e)))?;

        Ok(())
    }

    /// 获取数据库连接的可变引用
    pub fn connection(&self) -> Result<MutexGuard<'_, Connection>, AppError> {
        self.conn
            .lock()
            .map_err(|_| AppError::from("数据库锁被污染"))
    }
}
