pub mod git;
pub mod history;
pub mod resources;
pub mod static_files;
pub mod terminal;
pub mod workflow;

use axum::{
    routing::{delete, get, patch, post, put},
    Router,
};
use tower_http::cors::CorsLayer;

use crate::state::AppState;
use crate::ws_handler::ws_upgrade;

/// Build the axum router with all routes.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/api/sessions", post(terminal::create_session))
        .route("/api/sessions", get(terminal::list_sessions))
        .route(
            "/api/sessions/{id}/status",
            get(terminal::get_session_status),
        )
        .route(
            "/api/sessions/{id}/output",
            get(terminal::get_session_output),
        )
        .route(
            "/api/sessions/{id}/snapshot",
            get(terminal::get_session_snapshot),
        )
        .route("/api/sessions/{id}/write", post(terminal::write_session))
        .route("/api/sessions/{id}/submit", post(terminal::submit_session))
        .route("/api/sessions/{id}/resize", post(terminal::resize_session))
        .route("/api/sessions/{id}", delete(terminal::kill_session))
        .route("/api/launch-history", get(history::list_launch_history))
        .route("/api/launch-history", post(history::add_launch_history))
        .route("/api/launch-history", delete(history::clear_launch_history))
        .route(
            "/api/launch-history/by-pty",
            get(history::find_launch_history_by_pty_session),
        )
        .route(
            "/api/launch-history/by-resume",
            get(history::find_launch_history_by_resume_session),
        )
        .route(
            "/api/launch-history/by-launch",
            get(history::find_launch_history_by_launch_id),
        )
        .route(
            "/api/launch-history/touch-by-session",
            post(history::touch_launch_by_session),
        )
        .route(
            "/api/launch-history/by-pty/resume",
            patch(history::update_launch_resume_by_pty),
        )
        .route(
            "/api/launch-history/by-pty/last-prompt",
            patch(history::update_launch_last_prompt_by_pty),
        )
        .route(
            "/api/launch-history/session-started",
            patch(history::update_launch_session_started),
        )
        .route(
            "/api/launch-history/session-started/upsert",
            put(history::upsert_launch_session_started),
        )
        .route(
            "/api/launch-history/{id}",
            delete(history::delete_launch_history),
        )
        .route(
            "/api/launch-history/{id}/session-id",
            patch(history::update_launch_session_id),
        )
        .route(
            "/api/launch-history/{id}/resume-source",
            patch(history::update_launch_resume_source),
        )
        .route(
            "/api/launch-history/{id}/last-prompt",
            patch(history::update_launch_last_prompt),
        )
        .route("/api/session-state", get(history::read_session_state))
        .route(
            "/api/terminal-sessions",
            get(history::load_terminal_sessions),
        )
        .route(
            "/api/terminal-sessions",
            put(history::save_terminal_sessions),
        )
        .route(
            "/api/terminal-sessions",
            delete(history::clear_terminal_sessions),
        )
        .route(
            "/api/terminal-sessions/{session_id}/output",
            get(history::load_session_output),
        )
        .route(
            "/api/terminal-sessions/{session_id}/output",
            post(history::save_session_output),
        )
        .route(
            "/api/terminal-sessions/{session_id}/output",
            delete(history::clear_session_output),
        )
        .route(
            "/api/workspace-snapshots/{workspace_id}",
            get(history::list_workspace_snapshots),
        )
        .route(
            "/api/workspace-snapshots/{workspace_id}/{snapshot_id}",
            get(history::get_workspace_snapshot),
        )
        .route(
            "/api/workspace-snapshots/{workspace_id}/{snapshot_id}",
            delete(history::delete_workspace_snapshot),
        )
        .route("/api/git/branch", get(git::get_git_branch))
        .route("/api/git/status", get(git::get_git_status))
        .route("/api/git/file-statuses", get(git::get_git_file_statuses))
        .route("/api/git/pull", post(git::git_pull))
        .route("/api/git/push", post(git::git_push))
        .route("/api/git/fetch", post(git::git_fetch))
        .route("/api/git/stash", post(git::git_stash))
        .route("/api/git/stash-pop", post(git::git_stash_pop))
        .route("/api/git/clone", post(git::git_clone))
        .route("/api/worktrees/is-git-repo", get(git::is_git_repo))
        .route("/api/worktrees", get(git::list_worktrees))
        .route("/api/worktrees", post(git::add_worktree))
        .route("/api/worktrees", delete(git::remove_worktree))
        .route("/api/workspaces", get(resources::list_workspaces))
        .route("/api/workspaces", post(resources::create_workspace))
        .route(
            "/api/workspaces/reorder",
            post(resources::reorder_workspaces),
        )
        .route("/api/workspaces/{name}", get(resources::get_workspace))
        .route(
            "/api/workspaces/{name}",
            delete(resources::delete_workspace),
        )
        .route(
            "/api/workspaces/{name}/rename",
            post(resources::rename_workspace),
        )
        .route(
            "/api/workspaces/{name}/alias",
            patch(resources::update_workspace_alias),
        )
        .route(
            "/api/workspaces/{name}/path",
            patch(resources::update_workspace_path),
        )
        .route(
            "/api/workspaces/{name}/provider",
            patch(resources::update_workspace_provider),
        )
        .route(
            "/api/workspaces/{name}/projects",
            post(resources::add_workspace_project),
        )
        .route(
            "/api/workspaces/{name}/ssh-projects",
            post(resources::add_workspace_ssh_project),
        )
        .route(
            "/api/workspaces/{name}/projects/{project_id}",
            delete(resources::remove_workspace_project),
        )
        .route(
            "/api/workspaces/{name}/projects/{project_id}/alias",
            patch(resources::update_workspace_project_alias),
        )
        .route("/api/projects", get(resources::list_projects))
        .route("/api/projects", post(resources::add_project))
        .route("/api/projects/{id}", get(resources::get_project))
        .route("/api/projects/{id}", delete(resources::remove_project))
        .route(
            "/api/projects/{id}/name",
            patch(resources::update_project_name),
        )
        .route(
            "/api/projects/{id}/alias",
            patch(resources::update_project_alias),
        )
        .route("/api/providers", get(resources::list_providers))
        .route("/api/providers", post(resources::add_provider))
        .route(
            "/api/providers/default",
            get(resources::get_default_provider),
        )
        .route(
            "/api/providers/default",
            post(resources::set_default_provider),
        )
        .route("/api/providers/{id}", get(resources::get_provider))
        .route("/api/providers/{id}", put(resources::update_provider))
        .route("/api/providers/{id}", delete(resources::remove_provider))
        .route("/api/settings", get(resources::get_settings))
        .route("/api/settings", put(resources::update_settings))
        .route("/api/fs/list", get(resources::fs_list_directory))
        .route("/api/fs/read", get(resources::fs_read_file))
        .route("/api/fs/write", post(resources::fs_write_file))
        .route("/api/fs/create-file", post(resources::fs_create_file))
        .route(
            "/api/fs/create-directory",
            post(resources::fs_create_directory),
        )
        .route("/api/fs/delete", post(resources::fs_delete_entry))
        .route("/api/fs/rename", post(resources::fs_rename_entry))
        .route("/api/fs/copy", post(resources::fs_copy_entry))
        .route("/api/fs/move", post(resources::fs_move_entry))
        .route("/api/fs/info", get(resources::fs_get_entry_info))
        .route("/api/todos", post(workflow::create_todo))
        .route("/api/todos/query", post(workflow::query_todos))
        .route("/api/todos/reorder", post(workflow::reorder_todos))
        .route(
            "/api/todos/batch-status",
            post(workflow::batch_update_todo_status),
        )
        .route("/api/todos/stats", get(workflow::get_todo_stats))
        .route("/api/todos/reminders", get(workflow::check_todo_reminders))
        .route("/api/todos/{id}", get(workflow::get_todo))
        .route("/api/todos/{id}", patch(workflow::update_todo))
        .route("/api/todos/{id}", delete(workflow::delete_todo))
        .route(
            "/api/todos/{id}/toggle-my-day",
            post(workflow::toggle_todo_my_day),
        )
        .route("/api/todos/{id}/subtasks", post(workflow::add_todo_subtask))
        .route(
            "/api/todo-subtasks/reorder",
            post(workflow::reorder_todo_subtasks),
        )
        .route(
            "/api/todo-subtasks/{id}",
            patch(workflow::update_todo_subtask),
        )
        .route(
            "/api/todo-subtasks/{id}",
            delete(workflow::delete_todo_subtask),
        )
        .route(
            "/api/todo-subtasks/{id}/toggle",
            post(workflow::toggle_todo_subtask),
        )
        .route("/api/specs", post(workflow::create_spec))
        .route("/api/specs", get(workflow::list_specs))
        .route(
            "/api/specs/{spec_id}/content",
            get(workflow::get_spec_content),
        )
        .route(
            "/api/specs/{spec_id}/content",
            put(workflow::save_spec_content),
        )
        .route("/api/specs/{spec_id}", patch(workflow::update_spec))
        .route("/api/specs/{spec_id}", delete(workflow::delete_spec))
        .route(
            "/api/specs/{spec_id}/sync-tasks",
            post(workflow::sync_spec_tasks),
        )
        .route("/api/task-bindings", post(workflow::create_task_binding))
        .route(
            "/api/task-bindings/query",
            post(workflow::query_task_bindings),
        )
        .route(
            "/api/task-bindings/by-session",
            get(workflow::find_task_binding_by_session),
        )
        .route("/api/task-bindings/{id}", get(workflow::get_task_binding))
        .route(
            "/api/task-bindings/{id}",
            patch(workflow::update_task_binding),
        )
        .route(
            "/api/task-bindings/{id}/merge-patch",
            patch(workflow::update_task_binding_patch),
        )
        .route(
            "/api/task-bindings/{id}",
            delete(workflow::delete_task_binding),
        )
        .route(
            "/api/task-bindings/{id}/cascade",
            delete(workflow::delete_task_binding_cascade),
        )
        .route(
            "/api/plan-collaboration/leader",
            post(workflow::register_plan_leader),
        )
        .route(
            "/api/plan-collaboration/worker",
            post(workflow::register_plan_worker),
        )
        .route(
            "/api/plan-collaboration/child",
            post(workflow::register_plan_child),
        )
        .route(
            "/api/plan-collaboration",
            get(workflow::get_plan_collaboration),
        )
        .route(
            "/api/plan-collaboration/reconcile",
            post(workflow::reconcile_plan_collaboration),
        );

    let ws = Router::new().route("/ws/{session_id}", get(ws_upgrade));

    Router::new()
        .merge(api)
        .merge(ws)
        .fallback(static_files::static_handler)
        .layer(CorsLayer::permissive())
        .with_state(state)
}
