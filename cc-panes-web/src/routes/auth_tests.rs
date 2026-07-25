use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::{
    body::Body,
    extract::connect_info::ConnectInfo,
    http::{header, Request, StatusCode},
};
use cc_panes_core::{
    models::{settings::AppSettings, TerminalBufferMode},
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
use tower::util::ServiceExt;

use crate::{state::TerminalOutputMode, web_auth::WebAuthStore, ws_emitter::WsEmitter};

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
    let path = std::env::temp_dir().join(format!("cc-panes-web-auth-{name}-{millis}"));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn test_state(name: &str) -> crate::state::AppState {
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

    crate::state::AppState {
        terminal_backend: Arc::new(NoopTerminalBackend),
        workspace_service: Arc::new(WorkspaceService::new(app_paths.workspaces_dir())),
        project_service: Arc::new(ProjectService::new(project_repo)),
        provider_service: Arc::new(ProviderService::new(app_paths.providers_path())),
        settings_service: Arc::new(SettingsService::new_with_config_path(
            app_paths.data_dir().join("config.toml"),
        )),
        filesystem_service: Arc::new(FileSystemService::new()),
        todo_service: todo_service.clone(),
        spec_service: Arc::new(SpecService::new(spec_repo, todo_service)),
        task_binding_service: Arc::new(TaskBindingService::new(task_binding_repo)),
        launch_history_service,
        layout_snapshot_service: Arc::new(LayoutSnapshotService::new(db.clone())),
        launch_profile_service,
        quick_command_service: Arc::new(cc_panes_core::services::QuickCommandService::new(
            app_paths.quick_commands_path(),
        )),
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
        session_index_service: crate::state::test_session_index_service(app_paths.workspaces_dir()),
        ws_emitter: Arc::new(WsEmitter::new()),
        web_auth: Arc::new(WebAuthStore::default()),
        default_cwd: root.to_string_lossy().to_string(),
        output_mode: TerminalOutputMode::Emitter,
    }
}

fn enable_auth(state: &crate::state::AppState) {
    let mut settings = state.settings_service.get_settings();
    settings.web_access.auth_enabled = true;
    settings.web_access.username = "operator".to_string();
    settings
        .web_access
        .set_password("secret")
        .expect("set web password");
    state
        .settings_service
        .update_settings(settings)
        .expect("update auth settings");
}

fn remote_settings() -> AppSettings {
    let mut settings = AppSettings::default();
    settings.web_access.allow_lan = true;
    settings.web_access.auth_enabled = true;
    settings.web_access.username = "operator".to_string();
    settings
        .web_access
        .set_password("secret")
        .expect("set web password");
    settings.web_access.ip_whitelist = vec!["192.168.1.10".to_string()];
    settings
}

async fn login_cookie(app: axum::Router) -> String {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"username":"operator","password":"secret"}"#))
                .expect("login request"),
        )
        .await
        .expect("login response");

    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .expect("session cookie")
        .to_string()
}

#[tokio::test]
async fn default_web_api_does_not_require_login() {
    let state = test_state("default");
    let app = super::build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/settings")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn auth_enabled_api_requires_login_cookie() {
    let state = test_state("requires-login");
    enable_auth(&state);
    let app = super::build_router(state);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/settings")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let cookie = login_cookie(app.clone()).await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/settings")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .expect("authenticated request"),
        )
        .await
        .expect("authenticated response");

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn remote_read_only_blocks_write_unless_authenticated_write_enabled() {
    let state = test_state("read-only-authenticated-write");
    let mut settings = remote_settings();
    settings.web_access.ip_whitelist.clear();
    settings.web_access.remote_read_only = true;
    state
        .settings_service
        .update_settings(settings)
        .expect("enable read-only settings");
    let app = super::build_router(state.clone());
    let cookie = login_cookie(app.clone()).await;

    let write_request = |cookie: &str| {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/sessions/session/write")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, cookie)
            .header("x-forwarded-for", "100.64.0.5")
            .body(Body::from(r#"{"data":"ls"}"#))
            .expect("write request");
        request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
            IpAddr::from([127, 0, 0, 1]),
            4545,
        )));
        request
    };

    // 开关关闭：已登录的远程会话写入仍被只读模式拒绝（回归保护）
    let response = app
        .clone()
        .oneshot(write_request(&cookie))
        .await
        .expect("read-only response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // 开关开启：已登录的远程会话恢复写权限
    let mut settings = state.settings_service.get_settings();
    settings.web_access.remote_authenticated_write = true;
    state
        .settings_service
        .update_settings(settings)
        .expect("enable authenticated write");
    let response = app
        .oneshot(write_request(&cookie))
        .await
        .expect("authenticated write response");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn remote_api_respects_lan_gate_and_whitelist() {
    let state = test_state("remote");
    let app = super::build_router(state.clone());
    let mut request = Request::builder()
        .uri("/api/settings")
        .body(Body::empty())
        .expect("remote request");
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::from([192, 168, 1, 10]),
        4545,
    )));

    let response = app.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    state
        .settings_service
        .update_settings(remote_settings())
        .expect("enable remote settings");
    let cookie = login_cookie(app.clone()).await;
    let mut request = Request::builder()
        .uri("/api/settings")
        .header(header::COOKIE, cookie)
        .body(Body::empty())
        .expect("remote authenticated request");
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::from([192, 168, 1, 10]),
        4545,
    )));

    let response = app.oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}
