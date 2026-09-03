use crate::models::{
    CreateDramaEpisodeRequest, CreateDramaProjectRequest, CreateDramaShotRequest, DramaEpisode,
    DramaProject, DramaShot, UpdateDramaEpisodeRequest, UpdateDramaProjectRequest,
    UpdateDramaShotRequest,
};
use crate::repository::{Database, DramaRepository};
use std::sync::Arc;

const MAX_TITLE_BYTES: usize = 256;
const MAX_TEXT_BYTES: usize = 512 * 1024;

/// Business layer for the short-drama pipeline. Generation itself flows
/// through the media service; shots only hold loose references to media
/// nodes/runs, so this stays a validated CRUD facade shared by the Tauri and
/// Web entry points.
pub struct DramaService {
    repo: DramaRepository,
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    Ok(())
}

fn validate_title(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("title cannot be empty".to_string());
    }
    if value.len() > MAX_TITLE_BYTES {
        return Err(format!("title exceeds {MAX_TITLE_BYTES} bytes"));
    }
    Ok(())
}

fn validate_text(value: Option<&str>, label: &str) -> Result<(), String> {
    if let Some(text) = value {
        if text.len() > MAX_TEXT_BYTES {
            return Err(format!("{label} exceeds {MAX_TEXT_BYTES} bytes"));
        }
    }
    Ok(())
}

impl DramaService {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            repo: DramaRepository::new(db),
        }
    }

    // --- projects ---

    pub fn create_project(&self, req: &CreateDramaProjectRequest) -> Result<DramaProject, String> {
        validate_id(&req.workspace_id, "workspaceId")?;
        validate_title(&req.title)?;
        validate_text(req.description.as_deref(), "description")?;
        self.repo.insert_project(req)
    }

    pub fn get_project(&self, id: &str) -> Result<Option<DramaProject>, String> {
        validate_id(id, "dramaId")?;
        self.repo.get_project(id)
    }

    pub fn list_projects(&self, workspace_id: &str) -> Result<Vec<DramaProject>, String> {
        validate_id(workspace_id, "workspaceId")?;
        self.repo.list_projects(workspace_id)
    }

    pub fn update_project(
        &self,
        id: &str,
        req: &UpdateDramaProjectRequest,
    ) -> Result<DramaProject, String> {
        validate_id(id, "dramaId")?;
        if let Some(title) = req.title.as_deref() {
            validate_title(title)?;
        }
        validate_text(req.description.as_deref(), "description")?;
        self.repo.update_project(id, req)
    }

    pub fn delete_project(&self, id: &str) -> Result<bool, String> {
        validate_id(id, "dramaId")?;
        self.repo.delete_project(id)
    }

    // --- episodes ---

    pub fn create_episode(&self, req: &CreateDramaEpisodeRequest) -> Result<DramaEpisode, String> {
        validate_id(&req.drama_id, "dramaId")?;
        validate_title(&req.title)?;
        validate_text(req.screenplay.as_deref(), "screenplay")?;
        if self.repo.get_project(&req.drama_id)?.is_none() {
            return Err(format!("Drama project not found: {}", req.drama_id));
        }
        self.repo.insert_episode(req)
    }

    pub fn get_episode(&self, id: &str) -> Result<Option<DramaEpisode>, String> {
        validate_id(id, "episodeId")?;
        self.repo.get_episode(id)
    }

    pub fn list_episodes(&self, drama_id: &str) -> Result<Vec<DramaEpisode>, String> {
        validate_id(drama_id, "dramaId")?;
        self.repo.list_episodes(drama_id)
    }

    pub fn update_episode(
        &self,
        id: &str,
        req: &UpdateDramaEpisodeRequest,
    ) -> Result<DramaEpisode, String> {
        validate_id(id, "episodeId")?;
        if let Some(title) = req.title.as_deref() {
            validate_title(title)?;
        }
        validate_text(req.screenplay.as_deref(), "screenplay")?;
        self.repo.update_episode(id, req)
    }

    pub fn delete_episode(&self, id: &str) -> Result<bool, String> {
        validate_id(id, "episodeId")?;
        self.repo.delete_episode(id)
    }

    // --- shots ---

    pub fn create_shot(&self, req: &CreateDramaShotRequest) -> Result<DramaShot, String> {
        validate_id(&req.episode_id, "episodeId")?;
        validate_text(req.prompt.as_deref(), "prompt")?;
        validate_text(req.dialogue.as_deref(), "dialogue")?;
        if self.repo.get_episode(&req.episode_id)?.is_none() {
            return Err(format!("Drama episode not found: {}", req.episode_id));
        }
        self.repo.insert_shot(req)
    }

    pub fn list_shots(&self, episode_id: &str) -> Result<Vec<DramaShot>, String> {
        validate_id(episode_id, "episodeId")?;
        self.repo.list_shots(episode_id)
    }

    pub fn update_shot(&self, id: &str, req: &UpdateDramaShotRequest) -> Result<DramaShot, String> {
        validate_id(id, "shotId")?;
        validate_text(req.prompt.as_deref(), "prompt")?;
        validate_text(req.dialogue.as_deref(), "dialogue")?;
        self.repo.update_shot(id, req)
    }

    pub fn delete_shot(&self, id: &str) -> Result<bool, String> {
        validate_id(id, "shotId")?;
        self.repo.delete_shot(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> DramaService {
        DramaService::new(Arc::new(Database::new_in_memory().expect("db")))
    }

    #[test]
    fn rejects_empty_titles_and_missing_parents() {
        let service = service();
        let error = service
            .create_project(&CreateDramaProjectRequest {
                workspace_id: "ws".into(),
                title: "  ".into(),
                description: None,
            })
            .expect_err("empty title");
        assert!(error.contains("title"));

        let error = service
            .create_episode(&CreateDramaEpisodeRequest {
                drama_id: "missing".into(),
                title: "EP1".into(),
                ordinal: None,
                screenplay: None,
            })
            .expect_err("missing project");
        assert!(error.contains("not found"));
    }

    #[test]
    fn full_pipeline_crud_works() {
        let service = service();
        let project = service
            .create_project(&CreateDramaProjectRequest {
                workspace_id: "ws".into(),
                title: "Drama".into(),
                description: Some("desc".into()),
            })
            .expect("project");
        let episode = service
            .create_episode(&CreateDramaEpisodeRequest {
                drama_id: project.id.clone(),
                title: "EP1".into(),
                ordinal: None,
                screenplay: Some("script".into()),
            })
            .expect("episode");
        let shot = service
            .create_shot(&CreateDramaShotRequest {
                episode_id: episode.id.clone(),
                ordinal: None,
                title: Some("S1".into()),
                dialogue: None,
                prompt: Some("prompt".into()),
            })
            .expect("shot");
        assert_eq!(service.list_shots(&episode.id).expect("shots").len(), 1);
        assert!(service.delete_shot(&shot.id).expect("delete shot"));
        assert!(service.delete_project(&project.id).expect("delete project"));
        assert!(service.list_projects("ws").expect("projects").is_empty());
    }
}
