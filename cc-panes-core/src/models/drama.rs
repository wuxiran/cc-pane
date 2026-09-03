use serde::{Deserialize, Serialize};

/// Short-drama pipeline entities: a drama project groups episodes, an episode
/// owns a screenplay plus ordered shots, and each shot references the durable
/// media nodes/runs generated for it (loose TEXT references — the media graph
/// stays the source of truth for generation state).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DramaProject {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DramaEpisode {
    pub id: String,
    pub drama_id: String,
    pub ordinal: i64,
    pub title: String,
    pub screenplay: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DramaShot {
    pub id: String,
    pub episode_id: String,
    pub ordinal: i64,
    pub title: String,
    pub dialogue: String,
    pub prompt: String,
    pub image_node_id: Option<String>,
    pub image_run_id: Option<String>,
    pub video_node_id: Option<String>,
    pub video_run_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDramaProjectRequest {
    pub workspace_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDramaProjectRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDramaEpisodeRequest {
    pub drama_id: String,
    pub title: String,
    #[serde(default)]
    pub ordinal: Option<i64>,
    #[serde(default)]
    pub screenplay: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDramaEpisodeRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub ordinal: Option<i64>,
    #[serde(default)]
    pub screenplay: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDramaShotRequest {
    pub episode_id: String,
    #[serde(default)]
    pub ordinal: Option<i64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub dialogue: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
}

/// `Some(None)` cannot be expressed through plain JSON, so node/run references
/// are cleared by sending an empty string and set by sending the id.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDramaShotRequest {
    #[serde(default)]
    pub ordinal: Option<i64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub dialogue: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub image_node_id: Option<String>,
    #[serde(default)]
    pub image_run_id: Option<String>,
    #[serde(default)]
    pub video_node_id: Option<String>,
    #[serde(default)]
    pub video_run_id: Option<String>,
}
