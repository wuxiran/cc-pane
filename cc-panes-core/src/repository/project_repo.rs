use crate::models::Project;
use crate::repository::Database;
use crate::utils::{project_identity_key, repair_persisted_project_path};
use rusqlite::params;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::error;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ProjectIdentityMigrationReport {
    pub projects_updated: usize,
    pub duplicates_removed: usize,
}

struct ProjectIdentityWinner {
    id: String,
    original_path: String,
    persisted_path: String,
    original_alias: Option<String>,
    merged_alias: Option<String>,
}

/// 项目数据访问层 - 纯 CRUD 操作，不含业务逻辑
pub struct ProjectRepository {
    db: Arc<Database>,
}

impl ProjectRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// Deduplicate legacy SQLite registrations and repair unusable cross-host paths in one
    /// transaction. The identity key is never used as the persisted launch path.
    ///
    /// The earliest `(created_at, rowid)` record wins. A later non-empty alias only fills an
    /// empty winner alias; conflicting non-empty values keep the earliest registration.
    pub fn migrate_project_identities(&self) -> Result<ProjectIdentityMigrationReport, String> {
        let mut conn = self.db.connection().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut stmt = tx
            .prepare(
                "SELECT id, path, alias
                   FROM projects
               ORDER BY created_at ASC, rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut winners = Vec::<ProjectIdentityWinner>::new();
        let mut winner_by_identity = HashMap::<String, usize>::new();
        let mut duplicate_ids = Vec::<String>::new();
        for row in rows {
            let (id, path, alias) = row.map_err(|e| e.to_string())?;
            let identity = project_identity_key(&path);
            if let Some(index) = winner_by_identity.get(&identity).copied() {
                let winner = &mut winners[index];
                fill_non_empty(&mut winner.merged_alias, alias);
                duplicate_ids.push(id);
                continue;
            }

            winner_by_identity.insert(identity, winners.len());
            winners.push(ProjectIdentityWinner {
                id,
                persisted_path: repair_persisted_project_path(&path),
                original_path: path,
                original_alias: alias.clone(),
                merged_alias: alias,
            });
        }
        drop(stmt);

        for id in &duplicate_ids {
            tx.execute("DELETE FROM projects WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }

        let mut projects_updated = 0;
        for winner in &winners {
            if winner.original_path == winner.persisted_path
                && winner.original_alias == winner.merged_alias
            {
                continue;
            }
            tx.execute(
                "UPDATE projects SET path = ?1, alias = ?2 WHERE id = ?3",
                params![winner.persisted_path, winner.merged_alias, winner.id],
            )
            .map_err(|e| e.to_string())?;
            projects_updated += 1;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(ProjectIdentityMigrationReport {
            projects_updated,
            duplicates_removed: duplicate_ids.len(),
        })
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

    /// Check project identity across local Windows, `/mnt`, and WSL UNC representations.
    pub fn exists_by_identity(&self, path: &str) -> Result<bool, String> {
        let identity = project_identity_key(path);
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT path FROM projects").map_err(|e| {
            error!(table = "projects", err = %e, "SQL exists_by_identity prepare failed");
            e.to_string()
        })?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let registered: String = row.get(0).map_err(|e| e.to_string())?;
            if project_identity_key(&registered) == identity {
                return Ok(true);
            }
        }
        Ok(false)
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

fn fill_non_empty(target: &mut Option<String>, candidate: Option<String>) {
    let target_has_value = target
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let candidate_has_value = candidate
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    if !target_has_value && candidate_has_value {
        *target = candidate;
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
    fn test_exists_by_identity_matches_windows_wsl_variants() {
        let repo = setup();
        let project = make_project(r"D:\Repos\App");
        repo.insert(&project).unwrap();

        assert!(repo.exists_by_identity("/mnt/d/repos/app").unwrap());
        assert!(repo
            .exists_by_identity(r"\\wsl.localhost\Ubuntu\mnt\d\REPOS\APP")
            .unwrap());
        assert!(!repo.exists_by_identity(r"D:\Repos\Other").unwrap());
    }

    #[test]
    fn migrate_project_identities_deduplicates_and_is_idempotent() {
        let repo = setup();
        let mut first = make_project("/mnt/d/Repos/App");
        first.id = "first".to_string();
        first.created_at = "2026-01-01T00:00:00Z".to_string();
        let mut second = make_project(r"D:\repos\app");
        second.id = "second".to_string();
        second.created_at = "2026-01-02T00:00:00Z".to_string();
        let mut third = make_project(r"\\wsl$\Ubuntu\mnt\d\REPOS\APP");
        third.id = "third".to_string();
        third.created_at = "2026-01-03T00:00:00Z".to_string();
        let mut linux_a = make_project(r"\\wsl$\Ubuntu\home\User\App");
        linux_a.id = "linux-a".to_string();
        linux_a.created_at = "2026-01-04T00:00:00Z".to_string();
        let mut linux_b = make_project(r"\\wsl$\ubuntu\home\User\App");
        linux_b.id = "linux-b".to_string();
        linux_b.created_at = "2026-01-05T00:00:00Z".to_string();

        for project in [&first, &second, &third, &linux_a, &linux_b] {
            repo.insert(project).unwrap();
        }
        repo.update_alias(&second.id, Some("merged alias")).unwrap();
        repo.update_alias(&third.id, Some("later conflict"))
            .unwrap();

        let first_report = repo.migrate_project_identities().unwrap();
        assert_eq!(first_report.duplicates_removed, 2);
        let projects = repo.list().unwrap();
        assert_eq!(projects.len(), 3);

        let winner = projects
            .iter()
            .find(|project| project.id == "first")
            .unwrap();
        assert_eq!(winner.path, "/mnt/d/Repos/App");
        assert_eq!(winner.alias.as_deref(), Some("merged alias"));
        assert!(projects.iter().any(|project| {
            project.id == "linux-a" && project.path == r"\\wsl$\Ubuntu\home\User\App"
        }));
        assert!(projects.iter().any(|project| {
            project.id == "linux-b" && project.path == r"\\wsl$\ubuntu\home\User\App"
        }));

        assert_eq!(
            repo.migrate_project_identities().unwrap(),
            ProjectIdentityMigrationReport::default()
        );
    }

    #[cfg(unix)]
    #[test]
    fn migrate_project_identities_repairs_reachable_mnt_path_on_unix() {
        let current = std::env::current_dir().unwrap();
        let current = current.to_string_lossy().replace('\\', "/");
        if !current.starts_with("/mnt/") {
            return;
        }
        let broken = crate::utils::canonical_project_path(&current);
        assert_ne!(broken, current);

        let repo = setup();
        let mut project = make_project(&broken);
        project.id = "broken-cross-host-path".to_string();
        repo.insert(&project).unwrap();

        let first = repo.migrate_project_identities().unwrap();
        assert_eq!(first.projects_updated, 1);
        assert_eq!(repo.get(&project.id).unwrap().unwrap().path, current);
        assert_eq!(
            repo.migrate_project_identities().unwrap(),
            ProjectIdentityMigrationReport::default()
        );
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
