use crate::models::Project;
use crate::repository::Database;
use rusqlite::params;
use std::sync::Arc;
use tracing::error;

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
            .prepare(
                "SELECT id, name, path, created_at, alias FROM projects ORDER BY created_at DESC",
            )
            .map_err(|e| {
                error!(table = "projects", err = %e, "SQL prepare failed");
                e.to_string()
            })?;

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
            .map_err(|e| {
                error!(table = "projects", err = %e, "SQL query_map failed");
                e.to_string()
            })?
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
            Err(e) => {
                error!(table = "projects", err = %e, "SQL query failed");
                Err(e.to_string())
            }
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
                error!(table = "projects", path = %project.path, "Insert failed: project already exists");
                "Project already exists".to_string()
            } else {
                error!(table = "projects", err = %e, "SQL insert failed");
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
            .map_err(|e| {
                error!(table = "projects", id = %id, err = %e, "SQL delete failed");
                e.to_string()
            })?;

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
            .map_err(|e| {
                error!(table = "projects", id = %id, err = %e, "SQL update_name failed");
                e.to_string()
            })?;

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
            .map_err(|e| {
                error!(table = "projects", err = %e, "SQL exists_by_path query failed");
                e.to_string()
            })?;

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
            .map_err(|e| {
                error!(table = "projects", id = %id, err = %e, "SQL update_alias failed");
                e.to_string()
            })?;

        Ok(affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Project;
    use crate::repository::Database;

    fn setup() -> ProjectRepository {
        let db = Arc::new(Database::new_in_memory().expect("创建内存数据库失败"));
        ProjectRepository::new(db)
    }

    fn make_project(path: &str) -> Project {
        Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: path.split('/').last().unwrap_or("test").to_string(),
            path: path.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            alias: None,
        }
    }

    #[test]
    fn test_insert_and_list() {
        let repo = setup();
        let p1 = make_project("/tmp/project-a");
        let p2 = make_project("/tmp/project-b");

        repo.insert(&p1).unwrap();
        repo.insert(&p2).unwrap();

        let projects = repo.list().unwrap();
        assert_eq!(projects.len(), 2);
    }

    #[test]
    fn test_insert_duplicate_path_fails() {
        let repo = setup();
        let p1 = make_project("/tmp/same-path");
        let mut p2 = make_project("/tmp/same-path");
        p2.id = uuid::Uuid::new_v4().to_string();

        repo.insert(&p1).unwrap();
        let result = repo.insert(&p2);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Project already exists"));
    }

    #[test]
    fn test_get_existing() {
        let repo = setup();
        let project = make_project("/tmp/get-test");
        repo.insert(&project).unwrap();

        let found = repo.get(&project.id).unwrap();

        assert!(found.is_some());
        let found = found.unwrap();
        assert_eq!(found.id, project.id);
        assert_eq!(found.name, project.name);
        assert_eq!(found.path, project.path);
    }

    #[test]
    fn test_get_non_existing() {
        let repo = setup();

        let found = repo.get("non-existent-id").unwrap();

        assert!(found.is_none());
    }

    #[test]
    fn test_delete() {
        let repo = setup();
        let project = make_project("/tmp/delete-test");
        repo.insert(&project).unwrap();

        let deleted = repo.delete(&project.id).unwrap();
        assert!(deleted);

        let found = repo.get(&project.id).unwrap();
        assert!(found.is_none());
    }

    #[test]
    fn test_delete_non_existing() {
        let repo = setup();

        let deleted = repo.delete("non-existent-id").unwrap();

        assert!(!deleted);
    }

    #[test]
    fn test_update_name() {
        let repo = setup();
        let project = make_project("/tmp/rename-test");
        repo.insert(&project).unwrap();

        let updated = repo.update_name(&project.id, "新名称").unwrap();
        assert!(updated);

        let found = repo.get(&project.id).unwrap().unwrap();
        assert_eq!(found.name, "新名称");
    }

    #[test]
    fn test_exists_by_path() {
        let repo = setup();
        let project = make_project("/tmp/exists-test");
        repo.insert(&project).unwrap();

        assert!(repo.exists_by_path("/tmp/exists-test").unwrap());
        assert!(!repo.exists_by_path("/tmp/not-exists").unwrap());
    }

    #[test]
    fn test_update_alias() {
        let repo = setup();
        let project = make_project("/tmp/alias-test");
        repo.insert(&project).unwrap();

        // 设置别名
        let updated = repo.update_alias(&project.id, Some("我的项目")).unwrap();
        assert!(updated);

        let found = repo.get(&project.id).unwrap().unwrap();
        assert_eq!(found.alias, Some("我的项目".to_string()));

        // 清除别名
        let updated = repo.update_alias(&project.id, None).unwrap();
        assert!(updated);

        let found = repo.get(&project.id).unwrap().unwrap();
        assert!(found.alias.is_none());
    }
}
