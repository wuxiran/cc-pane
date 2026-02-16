use crate::models::Project;
use crate::repository::Database;
use rusqlite::params;
use std::sync::Arc;

/// 项目数据访问层 - 纯 CRUD 操作，不含业务逻辑
pub struct ProjectRepository {
    db: Arc<Database>,
}

impl ProjectRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 获取所有项目列表
    pub fn list(&self) -> Result<Vec<Project>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, path, created_at, alias FROM projects ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;

        let projects = stmt
            .query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    created_at: row.get(3)?,
                    alias: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(projects)
    }

    /// 根据 ID 获取单个项目
    pub fn get(&self, id: &str) -> Result<Option<Project>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, name, path, created_at, alias FROM projects WHERE id = ?1",
            params![id],
            |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    created_at: row.get(3)?,
                    alias: row.get(4)?,
                })
            },
        );

        match result {
            Ok(project) => Ok(Some(project)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 插入新项目
    pub fn insert(&self, project: &Project) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![project.id, project.name, project.path, project.created_at],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                "项目已存在".to_string()
            } else {
                e.to_string()
            }
        })?;

        Ok(())
    }

    /// 删除项目
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let affected = conn
            .execute("DELETE FROM projects WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;

        Ok(affected > 0)
    }

    /// 更新项目名称
    pub fn update_name(&self, id: &str, name: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE projects SET name = ?1 WHERE id = ?2",
                params![name, id],
            )
            .map_err(|e| e.to_string())?;

        Ok(affected > 0)
    }

    /// 检查路径是否已存在
    pub fn exists_by_path(&self, path: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        Ok(count > 0)
    }

    /// 更新项目别名
    pub fn update_alias(&self, id: &str, alias: Option<&str>) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE projects SET alias = ?1 WHERE id = ?2",
                params![alias, id],
            )
            .map_err(|e| e.to_string())?;

        Ok(affected > 0)
    }
}
