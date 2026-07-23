use std::{path::Path, process::Command, sync::Arc};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::TerminalBufferMode,
    repository::{
        Database, HistoryRepository, ProjectRepository, RunnerRepository, SpecRepository,
        TaskBindingRepository, TodoRepository,
    },
    services::{
        terminal_service::{SessionOutput, SessionStatus},
        FileSystemService, HistoryService, LaunchHistoryService, LayoutSnapshotService,
        McpConfigService, PlanService, ProcessMonitorService, ProjectService, ProviderService,
        RunnerService, SessionRestoreService, SettingsService, SharedMcpService, SpecService,
        SshCredentialService, SshMachineService, TaskBindingService, TerminalBackend, TodoService,
        WorkspaceService, WorktreeService,
    },
    utils::{AppPaths, AppResult},
};

use super::*;
use crate::{state::TerminalOutputMode, ws_emitter::WsEmitter};

struct NoopTerminalBackend;

impl TerminalBackend for NoopTerminalBackend {
    fn create_session(
        &self,
        _request: cc_panes_core::models::CreateSessionRequest,
    ) -> AppResult<String> {
        Ok("session".to_string())
    }

    fn write(&self, _session_id: &str, _data: &str) -> AppResult<()> {
        Ok(())
    }

    fn submit_text_to_session(&self, _session_id: &str, _text: &str) -> AppResult<()> {
        Ok(())
    }

    fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> AppResult<()> {
        Ok(())
    }

    fn kill(&self, _session_id: &str) -> AppResult<()> {
        Ok(())
    }

    fn get_all_status(&self) -> AppResult<Vec<cc_panes_core::services::SessionStatusInfo>> {
        Ok(vec![cc_panes_core::services::SessionStatusInfo {
            session_id: "session".to_string(),
            status: SessionStatus::Idle,
            last_output_at: 0,
            pid: None,
            exit_code: None,
            current_tool_name: None,
            current_tool_use_id: None,
            current_tool_summary: None,
            updated_at: 0,
        }])
    }

    fn get_session_status(
        &self,
        session_id: &str,
    ) -> AppResult<Option<cc_panes_core::services::SessionStatusInfo>> {
        Ok(self
            .get_all_status()?
            .into_iter()
            .find(|status| status.session_id == session_id))
    }

    fn get_session_output(&self, session_id: &str, _lines: usize) -> AppResult<SessionOutput> {
        Ok(SessionOutput {
            session_id: session_id.to_string(),
            lines: Vec::new(),
        })
    }

    fn get_session_replay_snapshot(
        &self,
        _session_id: &str,
    ) -> AppResult<Option<cc_panes_core::models::TerminalReplaySnapshot>> {
        Ok(Some(cc_panes_core::models::TerminalReplaySnapshot {
            data: String::new(),
            buffer_mode: TerminalBufferMode::Normal,
        }))
    }
}

fn test_dir(name: &str) -> std::path::PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_millis();
    let path = std::env::temp_dir().join(format!(
        "cc-panes-web-git-{name}-{millis}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn test_state(name: &str) -> (AppState, std::path::PathBuf) {
    let root = test_dir(name);
    let app_paths = Arc::new(AppPaths::new(Some(
        root.join("data").to_string_lossy().to_string(),
    )));
    let db = Arc::new(Database::new_fallback().expect("db"));
    let project_repo = Arc::new(ProjectRepository::new(db.clone()));
    let todo_repo = Arc::new(TodoRepository::new(db.clone()));
    let spec_repo = Arc::new(SpecRepository::new(db.clone()));
    let task_binding_repo = Arc::new(TaskBindingRepository::new(db.clone()));
    let history_repo = Arc::new(HistoryRepository::new(db.clone()));
    let runner_repo = Arc::new(RunnerRepository::new(db.clone()));
    let usage_stats_repo = Arc::new(cc_panes_core::repository::UsageStatsRepository::new(
        db.clone(),
    ));
    let todo_service = Arc::new(TodoService::new(todo_repo));
    let process_monitor_service = Arc::new(ProcessMonitorService::new());
    let launch_history_service = Arc::new(LaunchHistoryService::new(history_repo));
    let launch_profile_service = Arc::new(
        cc_panes_core::services::LaunchProfileService::new_with_external_skill_registry(
            app_paths.launch_profiles_path(),
            Arc::new(cc_panes_core::services::ExternalSkillRegistry::new(
                Arc::new(cc_cli_adapters::CliToolRegistry::new()),
            )),
        ),
    );
    let usage_stats_service = Arc::new(cc_panes_core::services::UsageStatsService::new(
        usage_stats_repo,
        launch_history_service.clone(),
    ));
    let memory_service =
        Arc::new(cc_panes_core::services::MemoryService::new_memory().expect("memory"));
    let ssh_machine_service = Arc::new(SshMachineService::new(
        app_paths.data_dir().join("ssh-machines.json"),
        Arc::new(SshCredentialService::new_memory()),
    ));
    let state = AppState {
        terminal_backend: Arc::new(NoopTerminalBackend),
        workspace_service: Arc::new(WorkspaceService::new(app_paths.workspaces_dir())),
        project_service: Arc::new(ProjectService::new(project_repo)),
        provider_service: Arc::new(ProviderService::new(app_paths.providers_path())),
        settings_service: Arc::new(SettingsService::new()),
        filesystem_service: Arc::new(FileSystemService::new()),
        todo_service: todo_service.clone(),
        spec_service: Arc::new(SpecService::new(spec_repo, todo_service)),
        task_binding_service: Arc::new(TaskBindingService::new(task_binding_repo)),
        launch_history_service,
        layout_snapshot_service: Arc::new(LayoutSnapshotService::new(db.clone())),
        launch_profile_service,
        memory_service,
        ssh_machine_service,
        session_restore_service: Arc::new(SessionRestoreService::new(db, app_paths.clone())),
        history_service: Arc::new(HistoryService::new()),
        worktree_service: Arc::new(WorktreeService::new()),
        runner_service: Arc::new(RunnerService::new(
            runner_repo,
            process_monitor_service.clone(),
        )),
        process_monitor_service,
        project_cli_hooks_service: Arc::new(cc_panes_core::services::ProjectCliHooksService::new(
            Arc::new(cc_cli_adapters::CliToolRegistry::new()),
        )),
        journal_service: Arc::new(cc_panes_core::services::JournalService::new(
            app_paths.workspaces_dir(),
        )),
        cli_registry: Arc::new(cc_cli_adapters::CliToolRegistry::new()),
        mcp_config_service: Arc::new(McpConfigService::new()),
        shared_mcp_service: Arc::new(SharedMcpService::new(&app_paths)),
        skill_service: Arc::new(cc_panes_core::services::SkillService::new()),
        plan_service: Arc::new(PlanService::new()),
        external_skill_registry: Arc::new(cc_panes_core::services::ExternalSkillRegistry::new(
            Arc::new(cc_cli_adapters::CliToolRegistry::new()),
        )),
        user_skill_service: Arc::new(cc_panes_core::services::UserSkillService::new(
            app_paths.user_skills_dir(),
        )),
        usage_stats_service,
        ws_emitter: Arc::new(WsEmitter::new()),
        web_auth: Arc::new(crate::web_auth::WebAuthStore::default()),
        default_cwd: root.to_string_lossy().to_string(),
        output_mode: TerminalOutputMode::Emitter,
    };
    (state, root)
}

fn run_git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {} failed\nstdout: {}\nstderr: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(path: &Path) {
    std::fs::create_dir_all(path).expect("create repo dir");
    run_git(path, &["init"]);
    run_git(path, &["config", "user.email", "test@example.com"]);
    run_git(path, &["config", "user.name", "Test User"]);
    // Keep line endings byte-for-byte so content round-trips through git
    // operations (e.g. stash/pop) identically on every platform. Without this,
    // a global `core.autocrlf=true` (common on Windows / GitHub runners) rewrites
    // LF to CRLF on checkout and breaks exact content assertions.
    run_git(path, &["config", "core.autocrlf", "false"]);
    std::fs::write(path.join("README.md"), "initial\n").expect("write readme");
    run_git(path, &["add", "README.md"]);
    run_git(path, &["commit", "-m", "initial"]);
}

#[tokio::test]
async fn git_read_routes_match_tauri_git_commands() {
    let (_state, root) = test_state("read");
    let repo = root.join("repo");
    init_repo(&repo);

    let Json(info) = get_git_repo_info(Query(PathQuery {
        path: repo.to_string_lossy().to_string(),
    }))
    .await
    .expect("repo info");
    assert_eq!(info.state, cc_panes_core::models::GitRepoState::Ok);
    assert_eq!(
        info.repo_root.as_deref(),
        Some(repo.to_string_lossy().as_ref())
    );

    let Json(branch) = get_git_branch(Query(PathQuery {
        path: repo.to_string_lossy().to_string(),
    }))
    .await
    .expect("branch");
    assert!(matches!(branch.as_deref(), Some("main") | Some("master")));

    std::fs::write(repo.join("README.md"), "modified\n").expect("modify readme");
    std::fs::write(repo.join("new.txt"), "new\n").expect("write new");

    let Json(dirty) = get_git_status(Query(PathQuery {
        path: repo.to_string_lossy().to_string(),
    }))
    .await
    .expect("status");
    assert_eq!(dirty, Some(true));

    let Json(statuses) = get_git_file_statuses(Query(PathQuery {
        path: repo.to_string_lossy().to_string(),
    }))
    .await
    .expect("file statuses");
    assert_eq!(
        statuses.get(&repo.join("README.md").to_string_lossy().to_string()),
        Some(&"modified".to_string())
    );
    assert_eq!(
        statuses.get(&repo.join("new.txt").to_string_lossy().to_string()),
        Some(&"untracked".to_string())
    );

    let Json(log) = get_git_log(Query(GitLogHttpQuery {
        path: repo.to_string_lossy().to_string(),
        query: cc_panes_core::models::GitLogQuery {
            limit: 1,
            ..Default::default()
        },
    }))
    .await
    .expect("git log");
    assert_eq!(log.commits.len(), 1);
    assert!(!log.has_more);

    let Json(branches) = get_git_local_branches(Query(PathQuery {
        path: repo.to_string_lossy().to_string(),
    }))
    .await
    .expect("local branches");
    assert_eq!(branches.len(), 1);

    let Json(changed) = get_git_changed_files(Query(PathQuery {
        path: repo.to_string_lossy().to_string(),
    }))
    .await
    .expect("changed files");
    assert_eq!(changed.len(), 2);

    let Json(diff) = get_git_diff(Json(GitDiffRequest {
        path: repo.to_string_lossy().to_string(),
        spec: cc_panes_core::models::GitDiffSpec::WorktreeVsHead {
            file: changed
                .iter()
                .find(|file| file.new_path.as_deref() == Some("README.md"))
                .unwrap()
                .clone(),
        },
    }))
    .await
    .expect("worktree diff");
    assert_eq!(diff.stats.changes, 1);

    let Json(commit_files) = list_git_commit_files(Query(GitCommitFilesQuery {
        path: repo.to_string_lossy().to_string(),
        commit: log.commits[0].hash.clone(),
        parent_index: None,
    }))
    .await
    .expect("commit files");
    assert_eq!(commit_files.len(), 1);
    assert_eq!(commit_files[0].new_mode.as_deref(), Some("100644"));
}

#[tokio::test]
async fn git_read_routes_keep_legacy_none_and_expose_failure_state() {
    let (_state, root) = test_state("read-invalid");
    let missing = root.join("missing").to_string_lossy().to_string();

    let Json(branch) = get_git_branch(Query(PathQuery {
        path: missing.clone(),
    }))
    .await
    .expect("legacy branch");
    let Json(status) = get_git_status(Query(PathQuery {
        path: missing.clone(),
    }))
    .await
    .expect("legacy status");
    let Json(info) = get_git_repo_info(Query(PathQuery { path: missing }))
        .await
        .expect("repo info");

    assert_eq!(branch, None);
    assert_eq!(status, None);
    assert_eq!(
        info.state,
        cc_panes_core::models::GitRepoState::PathNotFound
    );
}

#[tokio::test]
async fn git_write_routes_cover_stash_fetch_push_and_pull() {
    let (state, root) = test_state("write");
    let remote = root.join("remote.git");
    run_git(
        &root,
        &["init", "--bare", remote.to_string_lossy().as_ref()],
    );

    let repo = root.join("repo");
    init_repo(&repo);
    run_git(
        &repo,
        &["remote", "add", "origin", remote.to_string_lossy().as_ref()],
    );
    run_git(&repo, &["push", "-u", "origin", "HEAD"]);
    std::fs::write(repo.join("local.txt"), "local\n").expect("write local");
    run_git(&repo, &["add", "local.txt"]);
    run_git(&repo, &["commit", "-m", "local update"]);

    let Json(push_output) = git_push(
        State(state.clone()),
        Json(GitPathRequest {
            path: repo.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("push");
    assert!(!push_output.trim().is_empty());

    let Json(fetch_output) = git_fetch(Json(GitPathRequest {
        path: repo.to_string_lossy().to_string(),
    }))
    .await
    .expect("fetch");
    assert!(!fetch_output.trim().is_empty());

    let clone_dir = root.join("clone");
    run_git(
        &root,
        &[
            "clone",
            remote.to_string_lossy().as_ref(),
            clone_dir.to_string_lossy().as_ref(),
        ],
    );

    run_git(&clone_dir, &["config", "user.email", "test@example.com"]);
    run_git(&clone_dir, &["config", "user.name", "Test User"]);
    std::fs::write(clone_dir.join("remote.txt"), "remote\n").expect("write remote");
    run_git(&clone_dir, &["add", "remote.txt"]);
    run_git(&clone_dir, &["commit", "-m", "remote update"]);
    run_git(&clone_dir, &["push", "origin", "HEAD"]);

    let Json(pull_output) = git_pull(
        State(state.clone()),
        Json(GitPathRequest {
            path: repo.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("pull");
    assert!(!pull_output.trim().is_empty());
    assert!(repo.join("remote.txt").exists());

    std::fs::write(repo.join("README.md"), "stash change\n").expect("write stash");
    let Json(stash_output) = git_stash(
        State(state.clone()),
        Json(GitPathRequest {
            path: repo.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("stash");
    assert!(!stash_output.trim().is_empty());

    let Json(pop_output) = git_stash_pop(
        State(state),
        Json(GitPathRequest {
            path: repo.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("stash pop");
    assert!(!pop_output.trim().is_empty());
    assert_eq!(
        std::fs::read_to_string(repo.join("README.md")).expect("read readme"),
        "stash change\n"
    );
}

#[tokio::test]
async fn git_clone_rejects_non_http_urls_like_tauri_command() {
    let (_state, root) = test_state("clone-validation");
    let result = git_clone(Json(GitCloneRequest {
        url: "file:///tmp/repo.git".to_string(),
        target_dir: root.to_string_lossy().to_string(),
        folder_name: "clone".to_string(),
        shallow: false,
        username: None,
        password: None,
    }))
    .await;

    let Err((status, message)) = result else {
        panic!("file clone should be rejected");
    };
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(message.contains("Only HTTP/HTTPS"));
}

#[tokio::test]
async fn worktree_routes_match_core_service_operations() {
    let (state, root) = test_state("worktree");
    let repo = root.join("repo");
    init_repo(&repo);
    // canonicalize 解掉 Windows 8.3 短路径（CI 的 TEMP 是 RUNNER~1 形式，
    // git worktree list 输出长路径，路径比较会失败），再剥 \\?\ 前缀
    let repo = std::fs::canonicalize(&repo).expect("canonicalize repo");
    let project_path = repo.to_string_lossy().to_string();
    let project_path = project_path
        .strip_prefix(r"\\?\")
        .unwrap_or(&project_path)
        .to_string();

    let Json(is_repo) = is_git_repo(
        State(state.clone()),
        Query(WorktreeQuery {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("is git repo");
    assert!(is_repo);

    let Json(worktrees) = list_worktrees(
        State(state.clone()),
        Query(WorktreeQuery {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("list worktrees");
    assert_eq!(worktrees.len(), 1);

    let (status, Json(worktree_path)) = add_worktree(
        State(state.clone()),
        Json(AddWorktreeRequest {
            project_path: project_path.clone(),
            name: "feature-a".to_string(),
            branch: Some("feature-a".to_string()),
        }),
    )
    .await
    .expect("add worktree");
    assert_eq!(status, StatusCode::CREATED);
    assert!(Path::new(&worktree_path).exists());

    let Json(worktrees) = list_worktrees(
        State(state.clone()),
        Query(WorktreeQuery {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("list worktrees after add");
    // `git worktree list --porcelain` reports paths in git-canonical form
    // (forward slashes, and on Windows the drive-letter case may differ), while
    // `add_worktree` returns the path built with the host separator. Normalize
    // separators (and case on Windows) before comparing.
    let norm_path = |value: &str| {
        let normalized = value.replace('\\', "/");
        if cfg!(windows) {
            normalized.to_ascii_lowercase()
        } else {
            normalized
        }
    };
    let expected_worktree = norm_path(&worktree_path);
    assert!(worktrees
        .iter()
        .any(|worktree| norm_path(&worktree.path) == expected_worktree));

    remove_worktree(
        State(state),
        Json(RemoveWorktreeRequest {
            project_path,
            worktree_path: worktree_path.clone(),
        }),
    )
    .await
    .expect("remove worktree");
    assert!(!Path::new(&worktree_path).exists());
}
