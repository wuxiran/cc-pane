pub mod agent_sessions;
pub mod git;
pub mod history;
pub mod journal;
pub mod launch_profiles;
pub mod local_history;
pub mod mcp;
pub mod memory;
pub mod plans;
pub mod process;
pub mod resources;
pub mod runner;
pub mod skills;
pub mod ssh_machines;
pub mod static_files;
pub mod system;
pub mod terminal;
pub mod usage_stats;
pub mod workflow;

#[cfg(test)]
mod auth_tests;

use axum::{
    middleware,
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
        .route("/api/layout-snapshot", put(history::save_layout_snapshot))
        .route(
            "/api/layout-snapshot/{profile_id}",
            get(history::load_layout_snapshot),
        )
        .route(
            "/api/layout-snapshot/{profile_id}",
            delete(history::clear_layout_snapshot),
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
        .route("/api/runtime/cwd", get(system::get_app_cwd))
        .route("/api/cli-tools", get(system::list_cli_tools))
        .route("/api/project-cli-hooks", get(system::get_project_cli_hooks))
        .route(
            "/api/project-cli-hooks",
            put(system::set_project_cli_hook_enabled),
        )
        .route("/api/processes/claude", get(process::scan_claude_processes))
        .route(
            "/api/processes/claude",
            post(process::kill_claude_processes),
        )
        .route(
            "/api/processes/claude/{pid}",
            delete(process::kill_claude_process),
        )
        .route("/api/journal/session", post(journal::add_journal_session))
        .route("/api/journal/index", get(journal::get_journal_index))
        .route("/api/journal/recent", get(journal::get_recent_journal))
        .route(
            "/api/claude/sessions",
            get(agent_sessions::list_claude_sessions),
        )
        .route(
            "/api/claude/sessions/all",
            get(agent_sessions::list_all_claude_sessions),
        )
        .route(
            "/api/codex/sessions",
            get(agent_sessions::list_codex_sessions),
        )
        .route("/api/runner/profiles", get(runner::list_profiles))
        .route("/api/runner/profiles", put(runner::upsert_profile))
        .route("/api/runner/profiles/{id}", get(runner::get_profile))
        .route("/api/runner/profiles/{id}", delete(runner::delete_profile))
        .route(
            "/api/runner/profiles/{profile_id}/launch-plan",
            get(runner::plan_launch),
        )
        .route(
            "/api/runner/instances/active",
            get(runner::list_active_instances),
        )
        .route(
            "/api/runner/ports/conflicts",
            post(runner::list_port_conflicts),
        )
        .route(
            "/api/runner/instances/register-for-session",
            post(runner::register_for_session),
        )
        .route(
            "/api/runner/instances/register-implicit",
            post(runner::register_implicit_instance),
        )
        .route(
            "/api/runner/instances/{instance_id}/port-claims",
            post(runner::refresh_port_claims),
        )
        .route(
            "/api/runner/instances/{instance_id}/mark-exited",
            post(runner::mark_instance_exited),
        )
        .route(
            "/api/runner/instances/{instance_id}/kill",
            post(runner::kill_instance),
        )
        .route("/api/runner/pids/kill", post(runner::kill_pid))
        .route("/api/skills", get(skills::list_skills))
        .route("/api/skills", put(skills::save_skill))
        .route("/api/skills", delete(skills::delete_skill))
        .route("/api/skills/copy", post(skills::copy_skill))
        .route("/api/skills/{name}", get(skills::get_skill))
        .route("/api/external-skills", get(skills::list_external_skills))
        .route("/api/user-skills", get(skills::list_user_skills))
        .route(
            "/api/user-skills/{skill_id}",
            delete(skills::remove_user_skill),
        )
        .route("/api/ssh-machines", get(ssh_machines::list_ssh_machines))
        .route("/api/ssh-machines", post(ssh_machines::add_ssh_machine))
        .route("/api/ssh-machines", put(ssh_machines::update_ssh_machine))
        .route("/api/ssh-machines/{id}", get(ssh_machines::get_ssh_machine))
        .route(
            "/api/ssh-machines/{id}",
            delete(ssh_machines::remove_ssh_machine),
        )
        .route(
            "/api/ssh-machines/{id}/check",
            post(ssh_machines::check_ssh_connectivity),
        )
        .route(
            "/api/launch-profiles",
            get(launch_profiles::list_launch_profiles),
        )
        .route(
            "/api/launch-profiles",
            post(launch_profiles::create_launch_profile),
        )
        .route(
            "/api/launch-profiles/{id}",
            get(launch_profiles::get_launch_profile),
        )
        .route(
            "/api/launch-profiles/{id}",
            put(launch_profiles::update_launch_profile),
        )
        .route(
            "/api/launch-profiles/{id}",
            delete(launch_profiles::delete_launch_profile),
        )
        .route(
            "/api/launch-profiles/{id}/default",
            post(launch_profiles::set_default_launch_profile),
        )
        .route(
            "/api/launch-profiles/preview",
            post(launch_profiles::preview_launch_profile_resolution),
        )
        .route("/api/usage-stats", get(usage_stats::query_usage_stats))
        .route(
            "/api/usage-stats/input",
            post(usage_stats::record_terminal_input),
        )
        .route(
            "/api/usage-stats/refresh",
            post(usage_stats::refresh_usage_stats),
        )
        .route("/api/memories/search", post(memory::search_memory))
        .route("/api/memories", get(memory::list_memories))
        .route("/api/memories", post(memory::store_memory))
        .route("/api/memories/stats", get(memory::get_memory_stats))
        .route(
            "/api/memories/session-context",
            post(memory::prepare_session_context),
        )
        .route(
            "/api/memories/format",
            post(memory::format_memory_for_injection),
        )
        .route("/api/memories/{id}", get(memory::get_memory))
        .route("/api/memories/{id}", patch(memory::update_memory))
        .route("/api/memories/{id}", delete(memory::delete_memory))
        .route("/api/plans", get(plans::list_plans))
        .route("/api/plans/{file_name}", get(plans::get_plan_content))
        .route("/api/plans/{file_name}", delete(plans::delete_plan))
        .route("/api/mcp/servers", get(mcp::list_mcp_servers))
        .route("/api/mcp/servers", put(mcp::upsert_mcp_server))
        .route("/api/mcp/servers", delete(mcp::remove_mcp_server))
        .route("/api/mcp/servers/{name}", get(mcp::get_mcp_server))
        .route("/api/shared-mcp/config", get(mcp::get_shared_mcp_config))
        .route(
            "/api/shared-mcp/config",
            patch(mcp::update_shared_mcp_global_config),
        )
        .route("/api/shared-mcp/status", get(mcp::get_shared_mcp_status))
        .route(
            "/api/shared-mcp/servers",
            put(mcp::upsert_shared_mcp_server),
        )
        .route(
            "/api/shared-mcp/servers/import-from-claude",
            post(mcp::import_shared_mcp_from_claude),
        )
        .route(
            "/api/shared-mcp/servers/{name}",
            delete(mcp::remove_shared_mcp_server),
        )
        .route(
            "/api/shared-mcp/servers/{name}/start",
            post(mcp::start_shared_mcp_server),
        )
        .route(
            "/api/shared-mcp/servers/{name}/stop",
            post(mcp::stop_shared_mcp_server),
        )
        .route(
            "/api/shared-mcp/servers/{name}/restart",
            post(mcp::restart_shared_mcp_server),
        )
        .route(
            "/api/local-history/init",
            post(local_history::init_project_history),
        )
        .route(
            "/api/local-history/config",
            get(local_history::get_history_config),
        )
        .route(
            "/api/local-history/config",
            put(local_history::update_history_config),
        )
        .route(
            "/api/local-history/stop",
            post(local_history::stop_project_history),
        )
        .route(
            "/api/local-history/cleanup",
            post(local_history::cleanup_project_history),
        )
        .route(
            "/api/local-history/files/versions",
            get(local_history::list_file_versions),
        )
        .route(
            "/api/local-history/files/content",
            get(local_history::get_version_content),
        )
        .route(
            "/api/local-history/files/restore",
            post(local_history::restore_file_version),
        )
        .route(
            "/api/local-history/files/diff",
            get(local_history::get_version_diff),
        )
        .route(
            "/api/local-history/files/diff-between",
            get(local_history::get_versions_diff),
        )
        .route("/api/local-history/labels", put(local_history::put_label))
        .route("/api/local-history/labels", get(local_history::list_labels))
        .route(
            "/api/local-history/labels",
            delete(local_history::delete_label),
        )
        .route(
            "/api/local-history/labels/restore",
            post(local_history::restore_to_label),
        )
        .route(
            "/api/local-history/labels/auto",
            post(local_history::create_auto_label),
        )
        .route(
            "/api/local-history/directory-changes",
            get(local_history::list_directory_changes),
        )
        .route(
            "/api/local-history/recent-changes",
            get(local_history::get_recent_changes),
        )
        .route(
            "/api/local-history/deleted-files",
            get(local_history::list_deleted_files),
        )
        .route(
            "/api/local-history/compress",
            post(local_history::compress_history),
        )
        .route(
            "/api/local-history/current-branch",
            get(local_history::get_current_branch),
        )
        .route(
            "/api/local-history/file-branches",
            get(local_history::get_file_branches),
        )
        .route(
            "/api/local-history/file-versions-by-branch",
            get(local_history::list_file_versions_by_branch),
        )
        .route(
            "/api/local-history/worktree-recent-changes",
            get(local_history::list_worktree_recent_changes),
        )
        .route("/api/workspaces", get(resources::list_workspaces))
        .route("/api/workspaces", post(resources::create_workspace))
        .route(
            "/api/workspaces/reorder",
            post(resources::reorder_workspaces),
        )
        .route(
            "/api/workspace-scan",
            get(resources::scan_workspace_directory),
        )
        .route("/api/workspaces/{name}", get(resources::get_workspace))
        .route("/api/workspaces/{name}", put(resources::update_workspace))
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
        .route(
            "/api/workspace-migrations/preview",
            post(resources::preview_workspace_migration),
        )
        .route(
            "/api/workspace-migrations/execute",
            post(resources::execute_workspace_migration),
        )
        .route(
            "/api/workspace-migrations/{workspace_name}/{snapshot_id}/rollback",
            post(resources::rollback_workspace_migration),
        )
        .route(
            "/api/project-migrations/preview",
            post(resources::preview_project_migration),
        )
        .route(
            "/api/project-migrations/execute",
            post(resources::execute_project_migration),
        )
        .route(
            "/api/project-migrations/{workspace_name}/{snapshot_id}/rollback",
            post(resources::rollback_project_migration),
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
        .route(
            "/api/settings/web-access/password",
            post(resources::set_web_access_password),
        )
        .route("/api/fs/list", get(resources::fs_list_directory))
        .route("/api/fs/read", get(resources::fs_read_file))
        .route("/api/fs/raw", get(resources::fs_read_raw_file))
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
    let auth = Router::new()
        .route("/api/auth/status", get(crate::web_auth::status))
        .route("/api/auth/login", post(crate::web_auth::login))
        .route("/api/auth/logout", post(crate::web_auth::logout));
    // 层序：route_layer 后添加者更外层、先执行——access_control 必须先跑
    // （写入 RequestOrigin extension），read_only_guard 随后消费它。
    let protected = Router::new()
        .merge(api)
        .merge(ws)
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::web_auth::read_only_guard,
        ))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::web_auth::access_control,
        ));

    Router::new()
        .merge(auth)
        .merge(protected)
        .fallback(static_files::static_handler)
        .layer(CorsLayer::permissive())
        .with_state(state)
}
