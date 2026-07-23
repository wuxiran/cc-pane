use std::{collections::HashMap, path::Path, process::Command, time::Duration};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::{DiffResult, GitChangedFile, GitDiffSpec, GitLogPage, GitLogQuery, GitRepoInfo},
    services::{GitService, WorktreeInfo},
    utils::{
        output_with_timeout, prepare_git_clone_auth, validate_git_url, validate_path, AppResult,
        GIT_NETWORK_TIMEOUT,
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
pub struct GitLogHttpQuery {
    pub path: String,
    #[serde(flatten)]
    pub query: GitLogQuery,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFilesQuery {
    pub path: String,
    pub commit: String,
    pub parent_index: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffRequest {
    pub path: String,
    pub spec: GitDiffSpec,
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

async fn spawn_git<T, F>(task: F) -> Result<T, (StatusCode, String)>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(service_error)?
        .map_err(service_error)
}

fn get_git_repo_info_inner(path: &str) -> AppResult<GitRepoInfo> {
    validate_path(path)?;
    Ok(GitService::new().repo_info(Path::new(path)))
}

fn get_git_branch_inner(path: &str) -> AppResult<Option<String>> {
    validate_path(path)?;
    GitService::new()
        .get_branch_compat(Path::new(path))
        .map_err(Into::into)
}

fn get_git_status_inner(path: &str) -> AppResult<Option<bool>> {
    validate_path(path)?;
    GitService::new()
        .get_status_compat(Path::new(path))
        .map_err(Into::into)
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

    // 凭证经 GIT_CONFIG_* 环境变量注入 host 限定的 Authorization header，
    // URL 内嵌的 user:pass@ 也会被剥离（不落 .git/config、不进命令行）
    let (clean_url, credential_env) = prepare_git_clone_auth(
        &request.url,
        request.username.as_deref(),
        request.password.as_deref(),
    )?;

    let clone_path_str = clone_path.to_string_lossy().to_string();
    args.push(clean_url);
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
    GitService::new()
        .get_file_statuses_compat(Path::new(path))
        .map_err(Into::into)
}

pub async fn get_git_repo_info(
    Query(query): Query<PathQuery>,
) -> Result<Json<GitRepoInfo>, (StatusCode, String)> {
    let path = query.path;
    spawn_git(move || get_git_repo_info_inner(&path))
        .await
        .map(Json)
}

pub async fn get_git_branch(
    Query(query): Query<PathQuery>,
) -> Result<Json<Option<String>>, (StatusCode, String)> {
    let path = query.path;
    spawn_git(move || get_git_branch_inner(&path))
        .await
        .map(Json)
}

pub async fn get_git_status(
    Query(query): Query<PathQuery>,
) -> Result<Json<Option<bool>>, (StatusCode, String)> {
    let path = query.path;
    spawn_git(move || get_git_status_inner(&path))
        .await
        .map(Json)
}

pub async fn get_git_file_statuses(
    Query(query): Query<PathQuery>,
) -> Result<Json<HashMap<String, String>>, (StatusCode, String)> {
    let path = query.path;
    spawn_git(move || get_git_file_statuses_inner(&path))
        .await
        .map(Json)
}

pub async fn get_git_log(
    Query(query): Query<GitLogHttpQuery>,
) -> Result<Json<GitLogPage>, (StatusCode, String)> {
    spawn_git(move || {
        validate_path(&query.path)?;
        GitService::new()
            .get_log(Path::new(&query.path), &query.query)
            .map_err(Into::into)
    })
    .await
    .map(Json)
}

pub async fn get_git_local_branches(
    Query(query): Query<PathQuery>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    spawn_git(move || {
        validate_path(&query.path)?;
        GitService::new()
            .list_local_branches(Path::new(&query.path))
            .map_err(Into::into)
    })
    .await
    .map(Json)
}

pub async fn get_git_changed_files(
    Query(query): Query<PathQuery>,
) -> Result<Json<Vec<GitChangedFile>>, (StatusCode, String)> {
    spawn_git(move || {
        validate_path(&query.path)?;
        GitService::new()
            .status_files(Path::new(&query.path))
            .map_err(Into::into)
    })
    .await
    .map(Json)
}

pub async fn list_git_commit_files(
    Query(query): Query<GitCommitFilesQuery>,
) -> Result<Json<Vec<GitChangedFile>>, (StatusCode, String)> {
    spawn_git(move || {
        validate_path(&query.path)?;
        GitService::new()
            .list_commit_files(Path::new(&query.path), &query.commit, query.parent_index)
            .map_err(Into::into)
    })
    .await
    .map(Json)
}

pub async fn get_git_diff(
    Json(request): Json<GitDiffRequest>,
) -> Result<Json<DiffResult>, (StatusCode, String)> {
    spawn_git(move || {
        validate_path(&request.path)?;
        GitService::new()
            .get_diff(Path::new(&request.path), &request.spec)
            .map_err(Into::into)
    })
    .await
    .map(Json)
}

pub async fn git_pull(
    State(state): State<AppState>,
    Json(req): Json<GitPathRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    spawn_git(move || {
        auto_label_before_git(&state, &req.path, "Pull");
        run_git_command(&req.path, &["pull"])
    })
    .await
    .map(Json)
}

pub async fn git_push(
    State(state): State<AppState>,
    Json(req): Json<GitPathRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    spawn_git(move || {
        auto_label_before_git(&state, &req.path, "Push");
        run_git_command(&req.path, &["push"])
    })
    .await
    .map(Json)
}

pub async fn git_fetch(
    Json(req): Json<GitPathRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    spawn_git(move || run_git_command(&req.path, &["fetch", "--all"]))
        .await
        .map(Json)
}

pub async fn git_stash(
    State(state): State<AppState>,
    Json(req): Json<GitPathRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    spawn_git(move || {
        auto_label_before_git(&state, &req.path, "Stash");
        run_git_command(&req.path, &["stash"])
    })
    .await
    .map(Json)
}

pub async fn git_stash_pop(
    State(state): State<AppState>,
    Json(req): Json<GitPathRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    spawn_git(move || {
        auto_label_before_git(&state, &req.path, "Stash Pop");
        run_git_command(&req.path, &["stash", "pop"])
    })
    .await
    .map(Json)
}

pub async fn git_clone(
    Json(req): Json<GitCloneRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    spawn_git(move || clone_repository(req)).await.map(Json)
}

pub async fn is_git_repo(
    State(state): State<AppState>,
    Query(query): Query<WorktreeQuery>,
) -> Result<Json<bool>, (StatusCode, String)> {
    validate_path(&query.project_path).map_err(service_error)?;
    let service = state.worktree_service.clone();
    let project_path = query.project_path;
    tokio::task::spawn_blocking(move || service.is_git_repo(&project_path))
        .await
        .map(Json)
        .map_err(service_error)
}

pub async fn list_worktrees(
    State(state): State<AppState>,
    Query(query): Query<WorktreeQuery>,
) -> Result<Json<Vec<WorktreeInfo>>, (StatusCode, String)> {
    validate_path(&query.project_path).map_err(service_error)?;
    let service = state.worktree_service.clone();
    let project_path = query.project_path;
    tokio::task::spawn_blocking(move || service.list_worktrees(&project_path))
        .await
        .map_err(service_error)?
        .map(Json)
        .map_err(service_error)
}

pub async fn add_worktree(
    State(state): State<AppState>,
    Json(req): Json<AddWorktreeRequest>,
) -> Result<(StatusCode, Json<String>), (StatusCode, String)> {
    validate_path(&req.project_path).map_err(service_error)?;
    let service = state.worktree_service.clone();
    let path = tokio::task::spawn_blocking(move || {
        service.add_worktree(&req.project_path, &req.name, req.branch.as_deref())
    })
    .await
    .map_err(service_error)?
    .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(path)))
}

pub async fn remove_worktree(
    State(state): State<AppState>,
    Json(req): Json<RemoveWorktreeRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    validate_path(&req.project_path).map_err(service_error)?;
    validate_path(&req.worktree_path).map_err(service_error)?;
    let service = state.worktree_service.clone();
    tokio::task::spawn_blocking(move || {
        service.remove_worktree(&req.project_path, &req.worktree_path)
    })
    .await
    .map_err(service_error)?
    .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod git_tests;
