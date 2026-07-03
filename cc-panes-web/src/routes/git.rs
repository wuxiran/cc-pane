use std::{collections::HashMap, path::Path, process::Command, time::Duration};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    services::WorktreeInfo,
    utils::{
        git_https_credential_env, output_with_timeout, validate_git_url, validate_path, AppResult,
        GIT_LOCAL_TIMEOUT, GIT_NETWORK_TIMEOUT,
    },
};
use serde::Deserialize;

use crate::state::AppState;

const GIT_CLONE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathQuery {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPathRequest {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneRequest {
    pub url: String,
    pub target_dir: String,
    pub folder_name: String,
    pub shallow: bool,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeQuery {
    pub project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddWorktreeRequest {
    pub project_path: String,
    pub name: String,
    pub branch: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorktreeRequest {
    pub project_path: String,
    pub worktree_path: String,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

fn get_git_branch_inner(path: &str) -> AppResult<Option<String>> {
    validate_path(path)?;
    let project_path = Path::new(path);
    if !project_path.exists() {
        return Ok(None);
    }

    let output = output_with_timeout(
        Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(project_path),
        GIT_LOCAL_TIMEOUT,
    )?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok((!branch.is_empty()).then_some(branch))
    } else {
        Ok(None)
    }
}

fn get_git_status_inner(path: &str) -> AppResult<Option<bool>> {
    validate_path(path)?;
    let project_path = Path::new(path);
    if !project_path.exists() {
        return Ok(None);
    }

    let output = output_with_timeout(
        Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(project_path),
        GIT_LOCAL_TIMEOUT,
    )?;

    if output.status.success() {
        let status = String::from_utf8_lossy(&output.stdout);
        Ok(Some(!status.trim().is_empty()))
    } else {
        Ok(None)
    }
}

fn run_git_command(path: &str, args: &[&str]) -> AppResult<String> {
    validate_path(path)?;
    let project_path = Path::new(path);
    if !project_path.exists() {
        return Err("Path does not exist".into());
    }

    let output = output_with_timeout(
        Command::new("git").args(args).current_dir(project_path),
        GIT_NETWORK_TIMEOUT,
    )?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(if stdout.is_empty() {
            "Operation successful".to_string()
        } else {
            stdout
        })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr }.into())
    }
}

fn auto_label_before_git(state: &AppState, path: &str, operation: &str) {
    let label_name = format!("Before Git {operation}");
    let _ = state
        .history_service
        .create_auto_label(Path::new(path), &label_name, "git_commit");
}

fn clone_repository(request: GitCloneRequest) -> AppResult<String> {
    validate_git_url(&request.url)?;
    validate_path(&request.target_dir)?;
    let clone_path = Path::new(&request.target_dir).join(&request.folder_name);

    if clone_path.exists() {
        return Err("Target directory already exists".into());
    }

    let mut args: Vec<String> = vec!["clone".into()];
    if request.shallow {
        args.push("--depth".into());
        args.push("1".into());
    }

    // 凭证经 GIT_CONFIG_* 环境变量注入，URL 保持干净（不落 .git/config、不进命令行）
    let credential_env = match (&request.username, &request.password) {
        (Some(user), Some(pass)) => git_https_credential_env(&request.url, user, pass),
        _ => Vec::new(),
    };

    let clone_path_str = clone_path.to_string_lossy().to_string();
    args.push(request.url.clone());
    args.push(clone_path_str.clone());

    let output = output_with_timeout(
        Command::new("git")
            .args(&args)
            .envs(credential_env)
            .current_dir(&request.target_dir),
        GIT_CLONE_TIMEOUT,
    )?;
    if output.status.success() {
        Ok(clone_path_str)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(if stderr.is_empty() {
            stdout.to_string()
        } else {
            stderr.to_string()
        }
        .into())
    }
}

fn get_git_file_statuses_inner(path: &str) -> AppResult<HashMap<String, String>> {
    validate_path(path)?;
    let project_path = Path::new(path);
    if !project_path.exists() {
        return Ok(HashMap::new());
    }

    let output = output_with_timeout(
        Command::new("git")
            .args(["status", "--porcelain", "-unormal"])
            .current_dir(project_path),
        GIT_LOCAL_TIMEOUT,
    )?;

    if !output.status.success() {
        return Ok(HashMap::new());
    }

    let mut map = HashMap::new();
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let status_code = &line[..2];
        let file_path = line[3..].trim();
        let actual_path = if let Some(arrow_pos) = file_path.find(" -> ") {
            &file_path[arrow_pos + 4..]
        } else {
            file_path
        };
        let abs = project_path.join(actual_path);
        let status = match status_code.trim() {
            "M" | "MM" => "modified",
            "A" | "AM" => "added",
            "D" => "deleted",
            "R" | "RM" => "renamed",
            "??" => "untracked",
            s if s.ends_with('M') => "modified",
            s if s.ends_with('D') => "deleted",
            _ => "modified",
        };
        map.insert(abs.to_string_lossy().to_string(), status.to_string());
    }
    Ok(map)
}

pub async fn get_git_branch(
    Query(query): Query<PathQuery>,
) -> Result<Json<Option<String>>, (StatusCode, String)> {
    get_git_branch_inner(&query.path)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_git_status(
    Query(query): Query<PathQuery>,
) -> Result<Json<Option<bool>>, (StatusCode, String)> {
    get_git_status_inner(&query.path)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_git_file_statuses(
    Query(query): Query<PathQuery>,
) -> Result<Json<HashMap<String, String>>, (StatusCode, String)> {
    get_git_file_statuses_inner(&query.path)
        .map(Json)
        .map_err(service_error)
}

pub async fn git_pull(
    State(state): State<AppState>,
    Json(req): Json<GitPathRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    auto_label_before_git(&state, &req.path, "Pull");
    run_git_command(&req.path, &["pull"])
        .map(Json)
        .map_err(service_error)
}

pub async fn git_push(
    State(state): State<AppState>,
    Json(req): Json<GitPathRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    auto_label_before_git(&state, &req.path, "Push");
    run_git_command(&req.path, &["push"])
        .map(Json)
        .map_err(service_error)
}

pub async fn git_fetch(
    Json(req): Json<GitPathRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    run_git_command(&req.path, &["fetch", "--all"])
        .map(Json)
        .map_err(service_error)
}

pub async fn git_stash(
    State(state): State<AppState>,
    Json(req): Json<GitPathRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    auto_label_before_git(&state, &req.path, "Stash");
    run_git_command(&req.path, &["stash"])
        .map(Json)
        .map_err(service_error)
}

pub async fn git_stash_pop(
    State(state): State<AppState>,
    Json(req): Json<GitPathRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    auto_label_before_git(&state, &req.path, "Stash Pop");
    run_git_command(&req.path, &["stash", "pop"])
        .map(Json)
        .map_err(service_error)
}

pub async fn git_clone(
    Json(req): Json<GitCloneRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    clone_repository(req).map(Json).map_err(service_error)
}

pub async fn is_git_repo(
    State(state): State<AppState>,
    Query(query): Query<WorktreeQuery>,
) -> Result<Json<bool>, (StatusCode, String)> {
    validate_path(&query.project_path).map_err(service_error)?;
    Ok(Json(
        state.worktree_service.is_git_repo(&query.project_path),
    ))
}

pub async fn list_worktrees(
    State(state): State<AppState>,
    Query(query): Query<WorktreeQuery>,
) -> Result<Json<Vec<WorktreeInfo>>, (StatusCode, String)> {
    validate_path(&query.project_path).map_err(service_error)?;
    state
        .worktree_service
        .list_worktrees(&query.project_path)
        .map(Json)
        .map_err(service_error)
}

pub async fn add_worktree(
    State(state): State<AppState>,
    Json(req): Json<AddWorktreeRequest>,
) -> Result<(StatusCode, Json<String>), (StatusCode, String)> {
    validate_path(&req.project_path).map_err(service_error)?;
    let path = state
        .worktree_service
        .add_worktree(&req.project_path, &req.name, req.branch.as_deref())
        .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(path)))
}

pub async fn remove_worktree(
    State(state): State<AppState>,
    Json(req): Json<RemoveWorktreeRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    validate_path(&req.project_path).map_err(service_error)?;
    validate_path(&req.worktree_path).map_err(service_error)?;
    state
        .worktree_service
        .remove_worktree(&req.project_path, &req.worktree_path)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod git_tests;
