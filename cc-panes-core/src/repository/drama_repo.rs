use crate::models::{
    CreateDramaEpisodeRequest, CreateDramaProjectRequest, CreateDramaShotRequest, DramaEpisode,
    DramaProject, DramaShot, UpdateDramaEpisodeRequest, UpdateDramaProjectRequest,
    UpdateDramaShotRequest,
};
use crate::repository::Database;
use rusqlite::{params, Row};
use std::sync::Arc;

/// Persistence for the short-drama pipeline. Pure CRUD: generation state
/// lives in the media tables and is referenced by loose ids from shots.
pub struct DramaRepository {
    db: Arc<Database>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<DramaProject> {
    Ok(DramaProject {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn episode_from_row(row: &Row<'_>) -> rusqlite::Result<DramaEpisode> {
    Ok(DramaEpisode {
        id: row.get(0)?,
        drama_id: row.get(1)?,
        ordinal: row.get(2)?,
        title: row.get(3)?,
        screenplay: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn shot_from_row(row: &Row<'_>) -> rusqlite::Result<DramaShot> {
    Ok(DramaShot {
        id: row.get(0)?,
        episode_id: row.get(1)?,
        ordinal: row.get(2)?,
        title: row.get(3)?,
        dialogue: row.get(4)?,
        prompt: row.get(5)?,
        image_node_id: row.get(6)?,
        image_run_id: row.get(7)?,
        video_node_id: row.get(8)?,
        video_run_id: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

const PROJECT_COLUMNS: &str = "id, workspace_id, title, description, created_at, updated_at";
const EPISODE_COLUMNS: &str = "id, drama_id, ordinal, title, screenplay, created_at, updated_at";
const SHOT_COLUMNS: &str = "id, episode_id, ordinal, title, dialogue, prompt, image_node_id, image_run_id, video_node_id, video_run_id, created_at, updated_at";

/// Empty string clears an optional reference column; `None` leaves it as-is.
fn normalize_reference(value: Option<String>) -> Option<Option<String>> {
    value.map(|inner| {
        if inner.trim().is_empty() {
            None
        } else {
            Some(inner)
        }
    })
}

impl DramaRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    // --- projects ---

    pub fn insert_project(&self, req: &CreateDramaProjectRequest) -> Result<DramaProject, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = now();
        conn.execute(
            "INSERT INTO drama_projects (id, workspace_id, title, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                req.workspace_id,
                req.title,
                req.description.clone().unwrap_or_default(),
                timestamp,
                timestamp,
            ],
        )
        .map_err(|e| format!("Failed to insert drama project: {e}"))?;
        drop(conn);
        self.get_project(&id)?
            .ok_or_else(|| "Drama project vanished after insert".to_string())
    }

    pub fn get_project(&self, id: &str) -> Result<Option<DramaProject>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PROJECT_COLUMNS} FROM drama_projects WHERE id = ?1"
            ))
            .map_err(|e| e.to_string())?;
        match stmt.query_row([id], project_from_row) {
            Ok(project) => Ok(Some(project)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to load drama project: {e}")),
        }
    }

    pub fn list_projects(&self, workspace_id: &str) -> Result<Vec<DramaProject>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PROJECT_COLUMNS} FROM drama_projects
                 WHERE workspace_id = ?1 ORDER BY updated_at DESC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([workspace_id], project_from_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to list drama projects: {e}"))
    }

    pub fn update_project(
        &self,
        id: &str,
        req: &UpdateDramaProjectRequest,
    ) -> Result<DramaProject, String> {
        {
            let conn = self.db.connection().map_err(|e| e.to_string())?;
            let changed = conn
                .execute(
                    "UPDATE drama_projects SET
                        title = COALESCE(?2, title),
                        description = COALESCE(?3, description),
                        updated_at = ?4
                     WHERE id = ?1",
                    params![id, req.title, req.description, now()],
                )
                .map_err(|e| format!("Failed to update drama project: {e}"))?;
            if changed == 0 {
                return Err(format!("Drama project not found: {id}"));
            }
        }
        self.get_project(id)?
            .ok_or_else(|| format!("Drama project not found: {id}"))
    }

    pub fn delete_project(&self, id: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let changed = conn
            .execute("DELETE FROM drama_projects WHERE id = ?1", [id])
            .map_err(|e| format!("Failed to delete drama project: {e}"))?;
        Ok(changed > 0)
    }

    // --- episodes ---

    pub fn insert_episode(&self, req: &CreateDramaEpisodeRequest) -> Result<DramaEpisode, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = now();
        let ordinal = match req.ordinal {
            Some(ordinal) => ordinal,
            None => conn
                .query_row(
                    "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM drama_episodes WHERE drama_id = ?1",
                    [&req.drama_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|e| format!("Failed to compute episode ordinal: {e}"))?,
        };
        conn.execute(
            "INSERT INTO drama_episodes (id, drama_id, ordinal, title, screenplay, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                req.drama_id,
                ordinal,
                req.title,
                req.screenplay.clone().unwrap_or_default(),
                timestamp,
                timestamp,
            ],
        )
        .map_err(|e| format!("Failed to insert drama episode: {e}"))?;
        drop(conn);
        self.get_episode(&id)?
            .ok_or_else(|| "Drama episode vanished after insert".to_string())
    }

    pub fn get_episode(&self, id: &str) -> Result<Option<DramaEpisode>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {EPISODE_COLUMNS} FROM drama_episodes WHERE id = ?1"
            ))
            .map_err(|e| e.to_string())?;
        match stmt.query_row([id], episode_from_row) {
            Ok(episode) => Ok(Some(episode)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to load drama episode: {e}")),
        }
    }

    pub fn list_episodes(&self, drama_id: &str) -> Result<Vec<DramaEpisode>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {EPISODE_COLUMNS} FROM drama_episodes
                 WHERE drama_id = ?1 ORDER BY ordinal ASC, created_at ASC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([drama_id], episode_from_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to list drama episodes: {e}"))
    }

    pub fn update_episode(
        &self,
        id: &str,
        req: &UpdateDramaEpisodeRequest,
    ) -> Result<DramaEpisode, String> {
        {
            let conn = self.db.connection().map_err(|e| e.to_string())?;
            let changed = conn
                .execute(
                    "UPDATE drama_episodes SET
                        title = COALESCE(?2, title),
                        ordinal = COALESCE(?3, ordinal),
                        screenplay = COALESCE(?4, screenplay),
                        updated_at = ?5
                     WHERE id = ?1",
                    params![id, req.title, req.ordinal, req.screenplay, now()],
                )
                .map_err(|e| format!("Failed to update drama episode: {e}"))?;
            if changed == 0 {
                return Err(format!("Drama episode not found: {id}"));
            }
        }
        self.get_episode(id)?
            .ok_or_else(|| format!("Drama episode not found: {id}"))
    }

    pub fn delete_episode(&self, id: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let changed = conn
            .execute("DELETE FROM drama_episodes WHERE id = ?1", [id])
            .map_err(|e| format!("Failed to delete drama episode: {e}"))?;
        Ok(changed > 0)
    }

    // --- shots ---

    pub fn insert_shot(&self, req: &CreateDramaShotRequest) -> Result<DramaShot, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = now();
        let ordinal = match req.ordinal {
            Some(ordinal) => ordinal,
            None => conn
                .query_row(
                    "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM drama_shots WHERE episode_id = ?1",
                    [&req.episode_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|e| format!("Failed to compute shot ordinal: {e}"))?,
        };
        conn.execute(
            "INSERT INTO drama_shots (id, episode_id, ordinal, title, dialogue, prompt, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                req.episode_id,
                ordinal,
                req.title.clone().unwrap_or_default(),
                req.dialogue.clone().unwrap_or_default(),
                req.prompt.clone().unwrap_or_default(),
                timestamp,
                timestamp,
            ],
        )
        .map_err(|e| format!("Failed to insert drama shot: {e}"))?;
        drop(conn);
        self.get_shot(&id)?
            .ok_or_else(|| "Drama shot vanished after insert".to_string())
    }

    pub fn get_shot(&self, id: &str) -> Result<Option<DramaShot>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SHOT_COLUMNS} FROM drama_shots WHERE id = ?1"
            ))
            .map_err(|e| e.to_string())?;
        match stmt.query_row([id], shot_from_row) {
            Ok(shot) => Ok(Some(shot)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to load drama shot: {e}")),
        }
    }

    pub fn list_shots(&self, episode_id: &str) -> Result<Vec<DramaShot>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SHOT_COLUMNS} FROM drama_shots
                 WHERE episode_id = ?1 ORDER BY ordinal ASC, created_at ASC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([episode_id], shot_from_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to list drama shots: {e}"))
    }

    pub fn update_shot(&self, id: &str, req: &UpdateDramaShotRequest) -> Result<DramaShot, String> {
        {
            let conn = self.db.connection().map_err(|e| e.to_string())?;
            let current = {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT {SHOT_COLUMNS} FROM drama_shots WHERE id = ?1"
                    ))
                    .map_err(|e| e.to_string())?;
                match stmt.query_row([id], shot_from_row) {
                    Ok(shot) => shot,
                    Err(rusqlite::Error::QueryReturnedNoRows) => {
                        return Err(format!("Drama shot not found: {id}"))
                    }
                    Err(e) => return Err(format!("Failed to load drama shot: {e}")),
                }
            };
            let image_node_id =
                normalize_reference(req.image_node_id.clone()).unwrap_or(current.image_node_id);
            let image_run_id =
                normalize_reference(req.image_run_id.clone()).unwrap_or(current.image_run_id);
            let video_node_id =
                normalize_reference(req.video_node_id.clone()).unwrap_or(current.video_node_id);
            let video_run_id =
                normalize_reference(req.video_run_id.clone()).unwrap_or(current.video_run_id);
            conn.execute(
                "UPDATE drama_shots SET
                    ordinal = COALESCE(?2, ordinal),
                    title = COALESCE(?3, title),
                    dialogue = COALESCE(?4, dialogue),
                    prompt = COALESCE(?5, prompt),
                    image_node_id = ?6,
                    image_run_id = ?7,
                    video_node_id = ?8,
                    video_run_id = ?9,
                    updated_at = ?10
                 WHERE id = ?1",
                params![
                    id,
                    req.ordinal,
                    req.title,
                    req.dialogue,
                    req.prompt,
                    image_node_id,
                    image_run_id,
                    video_node_id,
                    video_run_id,
                    now(),
                ],
            )
            .map_err(|e| format!("Failed to update drama shot: {e}"))?;
        }
        self.get_shot(id)?
            .ok_or_else(|| format!("Drama shot not found: {id}"))
    }

    pub fn delete_shot(&self, id: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let changed = conn
            .execute("DELETE FROM drama_shots WHERE id = ?1", [id])
            .map_err(|e| format!("Failed to delete drama shot: {e}"))?;
        Ok(changed > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> DramaRepository {
        DramaRepository::new(Arc::new(Database::new_in_memory().expect("db")))
    }

    #[test]
    fn project_episode_shot_crud_round_trips() {
        let repo = repo();
        let project = repo
            .insert_project(&CreateDramaProjectRequest {
                workspace_id: "ws-1".into(),
                title: "My drama".into(),
                description: None,
            })
            .expect("project");
        assert_eq!(repo.list_projects("ws-1").expect("list").len(), 1);

        let episode = repo
            .insert_episode(&CreateDramaEpisodeRequest {
                drama_id: project.id.clone(),
                title: "EP1".into(),
                ordinal: None,
                screenplay: Some("Once upon a time".into()),
            })
            .expect("episode");
        assert_eq!(episode.ordinal, 0);

        let shot = repo
            .insert_shot(&CreateDramaShotRequest {
                episode_id: episode.id.clone(),
                ordinal: None,
                title: Some("Opening".into()),
                dialogue: None,
                prompt: Some("wide shot of a castle".into()),
            })
            .expect("shot");
        assert_eq!(shot.ordinal, 0);

        let updated = repo
            .update_shot(
                &shot.id,
                &UpdateDramaShotRequest {
                    image_node_id: Some("node-1".into()),
                    image_run_id: Some("run-1".into()),
                    ..Default::default()
                },
            )
            .expect("update shot");
        assert_eq!(updated.image_node_id.as_deref(), Some("node-1"));
        assert_eq!(updated.prompt, "wide shot of a castle");

        // Empty string clears the reference; None keeps it.
        let cleared = repo
            .update_shot(
                &shot.id,
                &UpdateDramaShotRequest {
                    image_node_id: Some(String::new()),
                    ..Default::default()
                },
            )
            .expect("clear reference");
        assert_eq!(cleared.image_node_id, None);
        assert_eq!(cleared.image_run_id.as_deref(), Some("run-1"));
    }

    #[test]
    fn deleting_project_cascades_to_episodes_and_shots() {
        let repo = repo();
        let project = repo
            .insert_project(&CreateDramaProjectRequest {
                workspace_id: "ws-1".into(),
                title: "Cascade".into(),
                description: None,
            })
            .expect("project");
        let episode = repo
            .insert_episode(&CreateDramaEpisodeRequest {
                drama_id: project.id.clone(),
                title: "EP1".into(),
                ordinal: None,
                screenplay: None,
            })
            .expect("episode");
        repo.insert_shot(&CreateDramaShotRequest {
            episode_id: episode.id.clone(),
            ordinal: None,
            title: None,
            dialogue: None,
            prompt: None,
        })
        .expect("shot");

        assert!(repo.delete_project(&project.id).expect("delete"));
        assert!(repo
            .get_episode(&episode.id)
            .expect("episode gone")
            .is_none());
        assert!(repo.list_shots(&episode.id).expect("shots gone").is_empty());
    }
}
