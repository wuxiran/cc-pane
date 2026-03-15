use crate::models::spec::{SpecEntry, SpecStatus};
use crate::repository::Database;
use std::sync::Arc;

pub struct SpecRepository {
    db: Arc<Database>,
}

impl SpecRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 插入 Spec 记录
    pub fn insert(&self, entry: &SpecEntry) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.message)?;
        conn.execute(
            "INSERT INTO specs (id, project_path, title, file_name, status, todo_id, created_at, updated_at, archived_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                entry.id,
                entry.project_path,
                entry.title,
                entry.file_name,
                entry.status.as_str(),
                entry.todo_id,
                entry.created_at,
                entry.updated_at,
                entry.archived_at,
            ],
        )
        .map_err(|e| format!("Failed to insert spec: {}", e))?;
        Ok(())
    }

    /// 根据 ID 获取 Spec
    pub fn get(&self, id: &str) -> Result<Option<SpecEntry>, String> {
        let conn = self.db.connection().map_err(|e| e.message)?;
        let mut stmt = conn
            .prepare(
                "SELECT id, project_path, title, file_name, status, todo_id, created_at, updated_at, archived_at
                 FROM specs WHERE id = ?1",
            )
            .map_err(|e| format!("Failed to prepare spec query: {}", e))?;

        let result = stmt
            .query_row(rusqlite::params![id], |row| {
                Ok(Self::row_to_entry(row))
            })
            .optional()
            .map_err(|e| format!("Failed to query spec: {}", e))?;

        match result {
            Some(entry) => Ok(Some(entry)),
            None => Ok(None),
        }
    }

    /// 按项目路径列出 Spec（可选按状态筛选）
    pub fn list_by_project(
        &self,
        project_path: &str,
        status: Option<&SpecStatus>,
    ) -> Result<Vec<SpecEntry>, String> {
        let conn = self.db.connection().map_err(|e| e.message)?;

        let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match status {
            Some(s) => (
                "SELECT id, project_path, title, file_name, status, todo_id, created_at, updated_at, archived_at
                 FROM specs WHERE project_path = ?1 AND status = ?2 ORDER BY created_at DESC"
                    .to_string(),
                vec![
                    Box::new(project_path.to_string()),
                    Box::new(s.as_str().to_string()),
                ],
            ),
            None => (
                "SELECT id, project_path, title, file_name, status, todo_id, created_at, updated_at, archived_at
                 FROM specs WHERE project_path = ?1 ORDER BY created_at DESC"
                    .to_string(),
                vec![Box::new(project_path.to_string())],
            ),
        };

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare list specs: {}", e))?;

        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();

        let entries = stmt
            .query_map(params_ref.as_slice(), |row| Ok(Self::row_to_entry(row)))
            .map_err(|e| format!("Failed to query specs: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect specs: {}", e))?;

        Ok(entries)
    }

    /// 更新 Spec 元数据
    pub fn update(
        &self,
        id: &str,
        title: Option<&str>,
        file_name: Option<&str>,
        status: Option<&SpecStatus>,
        todo_id: Option<&str>,
        archived_at: Option<&str>,
    ) -> Result<bool, String> {
        let mut sets = vec![];
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];

        if let Some(t) = title {
            sets.push(format!("title = ?{}", params.len() + 1));
            params.push(Box::new(t.to_string()));
        }
        if let Some(f) = file_name {
            sets.push(format!("file_name = ?{}", params.len() + 1));
            params.push(Box::new(f.to_string()));
        }
        if let Some(s) = status {
            sets.push(format!("status = ?{}", params.len() + 1));
            params.push(Box::new(s.as_str().to_string()));
        }
        if let Some(tid) = todo_id {
            sets.push(format!("todo_id = ?{}", params.len() + 1));
            params.push(Box::new(tid.to_string()));
        }
        if let Some(at) = archived_at {
            sets.push(format!("archived_at = ?{}", params.len() + 1));
            params.push(Box::new(at.to_string()));
        }

        // 总是更新 updated_at
        sets.push(format!("updated_at = ?{}", params.len() + 1));
        params.push(Box::new(chrono::Utc::now().to_rfc3339()));

        // WHERE id = ?
        params.push(Box::new(id.to_string()));
        let sql = format!(
            "UPDATE specs SET {} WHERE id = ?{}",
            sets.join(", "),
            params.len()
        );

        let conn = self.db.connection().map_err(|e| e.message)?;
        let rows = conn
            .execute(
                &sql,
                params
                    .iter()
                    .map(|p| p.as_ref())
                    .collect::<Vec<_>>()
                    .as_slice(),
            )
            .map_err(|e| format!("Failed to update spec: {}", e))?;
        Ok(rows > 0)
    }

    /// 取消项目中所有 active spec（用于激活新 spec 前）
    pub fn deactivate_all(&self, project_path: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.message)?;
        conn.execute(
            "UPDATE specs SET status = 'draft', updated_at = ?1 WHERE project_path = ?2 AND status = 'active'",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), project_path],
        )
        .map_err(|e| format!("Failed to deactivate specs: {}", e))?;
        Ok(())
    }

    /// 获取项目的 active spec
    pub fn get_active(&self, project_path: &str) -> Result<Option<SpecEntry>, String> {
        let conn = self.db.connection().map_err(|e| e.message)?;
        let mut stmt = conn
            .prepare(
                "SELECT id, project_path, title, file_name, status, todo_id, created_at, updated_at, archived_at
                 FROM specs WHERE project_path = ?1 AND status = 'active' LIMIT 1",
            )
            .map_err(|e| format!("Failed to prepare active spec query: {}", e))?;

        let result = stmt
            .query_row(rusqlite::params![project_path], |row| {
                Ok(Self::row_to_entry(row))
            })
            .optional()
            .map_err(|e| format!("Failed to query active spec: {}", e))?;

        match result {
            Some(entry) => Ok(Some(entry)),
            None => Ok(None),
        }
    }

    /// 删除 Spec 记录
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.message)?;
        let rows = conn
            .execute("DELETE FROM specs WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| format!("Failed to delete spec: {}", e))?;
        Ok(rows > 0)
    }

    /// 行映射
    fn row_to_entry(row: &rusqlite::Row) -> SpecEntry {
        let status_str: String = row.get(4).unwrap_or_default();
        SpecEntry {
            id: row.get(0).unwrap_or_default(),
            project_path: row.get(1).unwrap_or_default(),
            title: row.get(2).unwrap_or_default(),
            file_name: row.get(3).unwrap_or_default(),
            status: status_str
                .parse()
                .unwrap_or(SpecStatus::Draft),
            todo_id: row.get(5).unwrap_or(None),
            created_at: row.get(6).unwrap_or_default(),
            updated_at: row.get(7).unwrap_or_default(),
            archived_at: row.get(8).unwrap_or(None),
        }
    }
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> SpecRepository {
        let db = Arc::new(Database::new_in_memory().expect("创建内存数据库失败"));
        SpecRepository::new(db)
    }

    #[test]
    fn test_insert_and_get() {
        let repo = setup();
        let entry = SpecEntry {
            id: "spec-1".to_string(),
            project_path: "/path/to/project".to_string(),
            title: "Add dark mode".to_string(),
            file_name: "add-dark-mode.spec.md".to_string(),
            status: SpecStatus::Draft,
            todo_id: None,
            created_at: "2026-03-15T00:00:00Z".to_string(),
            updated_at: "2026-03-15T00:00:00Z".to_string(),
            archived_at: None,
        };
        repo.insert(&entry).unwrap();

        let result = repo.get("spec-1").unwrap();
        assert!(result.is_some());
        let got = result.unwrap();
        assert_eq!(got.title, "Add dark mode");
        assert_eq!(got.status, SpecStatus::Draft);
    }

    #[test]
    fn test_list_by_project() {
        let repo = setup();
        for i in 0..3 {
            repo.insert(&SpecEntry {
                id: format!("spec-{}", i),
                project_path: "/project".to_string(),
                title: format!("Spec {}", i),
                file_name: format!("spec-{}.spec.md", i),
                status: if i == 0 {
                    SpecStatus::Active
                } else {
                    SpecStatus::Draft
                },
                todo_id: None,
                created_at: "2026-03-15T00:00:00Z".to_string(),
                updated_at: "2026-03-15T00:00:00Z".to_string(),
                archived_at: None,
            })
            .unwrap();
        }

        let all = repo.list_by_project("/project", None).unwrap();
        assert_eq!(all.len(), 3);

        let drafts = repo
            .list_by_project("/project", Some(&SpecStatus::Draft))
            .unwrap();
        assert_eq!(drafts.len(), 2);
    }

    #[test]
    fn test_update() {
        let repo = setup();
        repo.insert(&SpecEntry {
            id: "spec-u".to_string(),
            project_path: "/project".to_string(),
            title: "Old title".to_string(),
            file_name: "old.spec.md".to_string(),
            status: SpecStatus::Draft,
            todo_id: None,
            created_at: "2026-03-15T00:00:00Z".to_string(),
            updated_at: "2026-03-15T00:00:00Z".to_string(),
            archived_at: None,
        })
        .unwrap();

        let updated = repo
            .update("spec-u", Some("New title"), None, Some(&SpecStatus::Active), None, None)
            .unwrap();
        assert!(updated);

        let got = repo.get("spec-u").unwrap().unwrap();
        assert_eq!(got.title, "New title");
        assert_eq!(got.status, SpecStatus::Active);
    }

    #[test]
    fn test_deactivate_all() {
        let repo = setup();
        repo.insert(&SpecEntry {
            id: "spec-a".to_string(),
            project_path: "/project".to_string(),
            title: "Active spec".to_string(),
            file_name: "active.spec.md".to_string(),
            status: SpecStatus::Active,
            todo_id: None,
            created_at: "2026-03-15T00:00:00Z".to_string(),
            updated_at: "2026-03-15T00:00:00Z".to_string(),
            archived_at: None,
        })
        .unwrap();

        repo.deactivate_all("/project").unwrap();
        let got = repo.get("spec-a").unwrap().unwrap();
        assert_eq!(got.status, SpecStatus::Draft);
    }

    #[test]
    fn test_get_active() {
        let repo = setup();
        repo.insert(&SpecEntry {
            id: "spec-active".to_string(),
            project_path: "/project".to_string(),
            title: "Active".to_string(),
            file_name: "active.spec.md".to_string(),
            status: SpecStatus::Active,
            todo_id: None,
            created_at: "2026-03-15T00:00:00Z".to_string(),
            updated_at: "2026-03-15T00:00:00Z".to_string(),
            archived_at: None,
        })
        .unwrap();

        let active = repo.get_active("/project").unwrap();
        assert!(active.is_some());
        assert_eq!(active.unwrap().id, "spec-active");

        let none = repo.get_active("/other").unwrap();
        assert!(none.is_none());
    }

    #[test]
    fn test_delete() {
        let repo = setup();
        repo.insert(&SpecEntry {
            id: "spec-d".to_string(),
            project_path: "/project".to_string(),
            title: "To delete".to_string(),
            file_name: "del.spec.md".to_string(),
            status: SpecStatus::Draft,
            todo_id: None,
            created_at: "2026-03-15T00:00:00Z".to_string(),
            updated_at: "2026-03-15T00:00:00Z".to_string(),
            archived_at: None,
        })
        .unwrap();

        assert!(repo.delete("spec-d").unwrap());
        assert!(repo.get("spec-d").unwrap().is_none());
    }
}
