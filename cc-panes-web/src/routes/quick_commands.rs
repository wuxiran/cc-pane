use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::models::{QuickCommand, QuickCommandDraft};
use serde::Deserialize;
use std::path::PathBuf;

use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectQuickCommandsQuery {
    pub project_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectQuickCommandsRequest {
    pub project_path: String,
    pub commands: Vec<QuickCommand>,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub async fn list_quick_commands(
    State(state): State<AppState>,
) -> Result<Json<Vec<QuickCommand>>, (StatusCode, String)> {
    Ok(Json(state.quick_command_service.list_global()))
}

pub async fn create_quick_command(
    State(state): State<AppState>,
    Json(draft): Json<QuickCommandDraft>,
) -> Result<(StatusCode, Json<QuickCommand>), (StatusCode, String)> {
    let command = state
        .quick_command_service
        .create_global(draft)
        .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(command)))
}

pub async fn update_quick_command(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(draft): Json<QuickCommandDraft>,
) -> Result<Json<QuickCommand>, (StatusCode, String)> {
    state
        .quick_command_service
        .update_global(&id, draft)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_quick_command(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .quick_command_service
        .delete_global(&id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_project_quick_commands(
    State(state): State<AppState>,
    Query(query): Query<ProjectQuickCommandsQuery>,
) -> Result<Json<Vec<QuickCommand>>, (StatusCode, String)> {
    state
        .quick_command_service
        .list_project(&PathBuf::from(query.project_path))
        .map(Json)
        .map_err(service_error)
}

pub async fn save_project_quick_commands(
    State(state): State<AppState>,
    Json(request): Json<SaveProjectQuickCommandsRequest>,
) -> Result<Json<Vec<QuickCommand>>, (StatusCode, String)> {
    state
        .quick_command_service
        .save_project(&PathBuf::from(request.project_path), request.commands)
        .map(Json)
        .map_err(service_error)
}

#[cfg(test)]
mod tests {
    use axum::{
        extract::{Query, State},
        http::StatusCode,
        Json,
    };
    use cc_panes_core::models::{QuickCommandDraft, QuickCommandKind, QuickCommandTarget};

    use super::*;
    use crate::routes::launch_profiles::launch_profiles_tests::test_state;

    fn draft(name: &str) -> QuickCommandDraft {
        QuickCommandDraft {
            name: name.to_string(),
            kind: QuickCommandKind::Terminal,
            text: "cargo test".to_string(),
            append_enter: true,
            target: QuickCommandTarget::CurrentPane,
            cli_tool: None,
        }
    }

    #[tokio::test]
    async fn quick_command_routes_manage_global_crud() {
        let (state, root) = test_state("quick-command-global");

        let (status, Json(created)) =
            create_quick_command(State(state.clone()), Json(draft("Run tests")))
                .await
                .expect("create quick command");
        assert_eq!(status, StatusCode::CREATED);

        let Json(listed) = list_quick_commands(State(state.clone()))
            .await
            .expect("list quick commands");
        assert_eq!(listed, vec![created.clone()]);

        let Json(updated) = update_quick_command(
            State(state.clone()),
            axum::extract::Path(created.id.clone()),
            Json(QuickCommandDraft {
                name: "Run focused tests".to_string(),
                ..draft("Run tests")
            }),
        )
        .await
        .expect("update quick command");
        assert_eq!(updated.name, "Run focused tests");

        assert_eq!(
            delete_quick_command(State(state), axum::extract::Path(created.id))
                .await
                .expect("delete quick command"),
            StatusCode::NO_CONTENT
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn quick_command_routes_round_trip_project_commands() {
        let (state, root) = test_state("quick-command-project");
        let project_path = root.join("project");
        std::fs::create_dir_all(&project_path).expect("create project");
        let (_status, Json(command)) =
            create_quick_command(State(state.clone()), Json(draft("Project tests")))
                .await
                .expect("create seed command");
        let request = SaveProjectQuickCommandsRequest {
            project_path: project_path.to_string_lossy().to_string(),
            commands: vec![command.clone()],
        };

        let Json(saved) = save_project_quick_commands(State(state.clone()), Json(request))
            .await
            .expect("save project quick commands");
        assert_eq!(saved, vec![command.clone()]);

        let Json(listed) = list_project_quick_commands(
            State(state),
            Query(ProjectQuickCommandsQuery {
                project_path: project_path.to_string_lossy().to_string(),
            }),
        )
        .await
        .expect("list project quick commands");
        assert_eq!(listed, vec![command]);
        std::fs::remove_dir_all(root).ok();
    }
}
