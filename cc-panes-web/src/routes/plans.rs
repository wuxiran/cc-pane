use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{services::plan_service::PlanEntry, utils::validate_path};
use serde::Deserialize;

use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlansQuery {
    pub project_path: String,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub async fn list_plans(
    State(state): State<AppState>,
    Query(query): Query<PlansQuery>,
) -> Result<Json<Vec<PlanEntry>>, (StatusCode, String)> {
    validate_path(&query.project_path).map_err(service_error)?;
    state
        .plan_service
        .list_plans(&query.project_path)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_plan_content(
    State(state): State<AppState>,
    Path(file_name): Path<String>,
    Query(query): Query<PlansQuery>,
) -> Result<Json<String>, (StatusCode, String)> {
    validate_path(&query.project_path).map_err(service_error)?;
    state
        .plan_service
        .get_plan_content(&query.project_path, &file_name)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_plan(
    State(state): State<AppState>,
    Path(file_name): Path<String>,
    Query(query): Query<PlansQuery>,
) -> Result<StatusCode, (StatusCode, String)> {
    validate_path(&query.project_path).map_err(service_error)?;
    state
        .plan_service
        .delete_plan(&query.project_path, &file_name)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
#[path = "plans_tests.rs"]
mod plans_tests;
