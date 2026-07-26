use crate::models::ai_panel::{AiPanelSummary, StoredAiPanel};
use crate::repository::Database;
use std::sync::Arc;

/// AI 面板历史仓库。
///
/// 面板一旦创建就留在库里，`close` 只是让它离开活跃集、变成历史；
/// 真正的删除只有用户在 UI 上显式触发（本仓库不做任何自动清理）。
pub struct AiPanelRepository {
    db: Arc<Database>,
}

impl AiPanelRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 写入或整体更新一个面板。`created_at` 只在首次插入时落，后续更新保留原值。
    pub fn upsert(&self, panel: &StoredAiPanel) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO ai_panels (
                panel_id, workspace_name, project_path, title, format, content,
                driver_name, owner_session_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(panel_id) DO UPDATE SET
                workspace_name = excluded.workspace_name,
                project_path = excluded.project_path,
                title = excluded.title,
                format = excluded.format,
                content = excluded.content,
                driver_name = excluded.driver_name,
                owner_session_id = excluded.owner_session_id,
                updated_at = excluded.updated_at",
            rusqlite::params![
                panel.panel_id,
                panel.workspace_name,
                panel.project_path,
                panel.title,
                panel.format,
                panel.content,
                panel.driver_name,
                panel.owner_session_id,
                panel.created_at,
                panel.updated_at,
            ],
        )
        .map_err(|e| format!("Failed to upsert ai panel: {}", e))?;
        Ok(())
    }

    pub fn get(&self, panel_id: &str) -> Result<Option<StoredAiPanel>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT panel_id, workspace_name, project_path, title, format, content,
                        driver_name, owner_session_id, created_at, updated_at
                 FROM ai_panels WHERE panel_id = ?1",
            )
            .map_err(|e| format!("Failed to prepare ai panel query: {}", e))?;

        let result = stmt.query_row([panel_id], |row| {
            Ok(StoredAiPanel {
                panel_id: row.get(0)?,
                workspace_name: row.get(1)?,
                project_path: row.get(2)?,
                title: row.get(3)?,
                format: row.get(4)?,
                content: row.get(5)?,
                driver_name: row.get(6)?,
                owner_session_id: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        });

        match result {
            Ok(panel) => Ok(Some(panel)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to load ai panel: {}", e)),
        }
    }

    /// 全部历史摘要，按工作空间分组友好排序（未归类的排最后，组内按最近更新倒序）。
    pub fn list_summaries(&self) -> Result<Vec<AiPanelSummary>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT panel_id, workspace_name, project_path, title, format,
                        driver_name, owner_session_id, length(content), created_at, updated_at
                 FROM ai_panels
                 ORDER BY workspace_name IS NULL, workspace_name COLLATE NOCASE, updated_at DESC",
            )
            .map_err(|e| format!("Failed to prepare ai panel list: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(AiPanelSummary {
                    panel_id: row.get(0)?,
                    workspace_name: row.get(1)?,
                    project_path: row.get(2)?,
                    title: row.get(3)?,
                    format: row.get(4)?,
                    driver_name: row.get(5)?,
                    owner_session_id: row.get(6)?,
                    content_bytes: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to query ai panels: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read ai panel rows: {}", e))
    }

    /// 用户显式删除。返回是否真的删掉了一行。
    pub fn delete(&self, panel_id: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let affected = conn
            .execute("DELETE FROM ai_panels WHERE panel_id = ?1", [panel_id])
            .map_err(|e| format!("Failed to delete ai panel: {}", e))?;
        Ok(affected > 0)
    }

    /// 转移或清空持有者，用于「认领历史面板」与「关闭后释放」。
    pub fn set_owner(&self, panel_id: &str, owner_session_id: Option<&str>) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE ai_panels SET owner_session_id = ?2 WHERE panel_id = ?1",
            rusqlite::params![panel_id, owner_session_id],
        )
        .map_err(|e| format!("Failed to set ai panel owner: {}", e))?;
        Ok(())
    }

    /// 某会话当前持有的面板数，用于每会话上限校验。
    pub fn count_owned_by(&self, owner_session_id: &str) -> Result<usize, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ai_panels WHERE owner_session_id = ?1",
                [owner_session_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to count owned ai panels: {}", e))?;
        Ok(count as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn panel(panel_id: &str, workspace: Option<&str>, owner: Option<&str>) -> StoredAiPanel {
        StoredAiPanel {
            panel_id: panel_id.to_string(),
            workspace_name: workspace.map(str::to_string),
            project_path: Some("D:/repo".to_string()),
            title: format!("Panel {}", panel_id),
            format: "html".to_string(),
            content: "<p>hi</p>".to_string(),
            driver_name: "Worker A".to_string(),
            owner_session_id: owner.map(str::to_string),
            created_at: "2026-07-26T10:00:00Z".to_string(),
            updated_at: "2026-07-26T10:00:00Z".to_string(),
        }
    }

    fn repo() -> AiPanelRepository {
        AiPanelRepository::new(Arc::new(Database::new_in_memory().expect("in-memory db")))
    }

    #[test]
    fn upsert_preserves_created_at_while_refreshing_content() {
        let repo = repo();
        repo.upsert(&panel("p1", Some("ws"), Some("s1"))).unwrap();

        let mut updated = panel("p1", Some("ws"), Some("s1"));
        updated.content = "<p>second</p>".to_string();
        updated.created_at = "2099-01-01T00:00:00Z".to_string();
        updated.updated_at = "2026-07-26T11:00:00Z".to_string();
        repo.upsert(&updated).unwrap();

        let stored = repo.get("p1").unwrap().expect("panel exists");
        assert_eq!(stored.content, "<p>second</p>");
        assert_eq!(stored.updated_at, "2026-07-26T11:00:00Z");
        // 首次插入的 created_at 不该被后续更新覆盖
        assert_eq!(stored.created_at, "2026-07-26T10:00:00Z");
    }

    #[test]
    fn summaries_group_by_workspace_and_omit_content() {
        let repo = repo();
        repo.upsert(&panel("p1", Some("beta"), None)).unwrap();
        repo.upsert(&panel("p2", Some("alpha"), None)).unwrap();
        repo.upsert(&panel("p3", None, None)).unwrap();

        let summaries = repo.list_summaries().unwrap();
        let order: Vec<_> = summaries.iter().map(|s| s.workspace_name.clone()).collect();
        assert_eq!(
            order,
            vec![
                Some("alpha".to_string()),
                Some("beta".to_string()),
                None, // 未归类固定排最后
            ]
        );
        assert_eq!(summaries[0].content_bytes, "<p>hi</p>".len() as i64);
    }

    #[test]
    fn ownership_can_be_transferred_and_released() {
        let repo = repo();
        repo.upsert(&panel("p1", Some("ws"), Some("s1"))).unwrap();
        assert_eq!(repo.count_owned_by("s1").unwrap(), 1);

        repo.set_owner("p1", Some("s2")).unwrap();
        assert_eq!(repo.count_owned_by("s1").unwrap(), 0);
        assert_eq!(repo.count_owned_by("s2").unwrap(), 1);

        repo.set_owner("p1", None).unwrap();
        assert_eq!(repo.count_owned_by("s2").unwrap(), 0);
        assert!(repo.get("p1").unwrap().unwrap().owner_session_id.is_none());
    }

    #[test]
    fn delete_reports_whether_a_row_was_removed() {
        let repo = repo();
        repo.upsert(&panel("p1", Some("ws"), None)).unwrap();

        assert!(repo.delete("p1").unwrap());
        assert!(!repo.delete("p1").unwrap());
        assert!(repo.get("p1").unwrap().is_none());
    }
}
