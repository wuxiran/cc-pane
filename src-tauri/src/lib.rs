#[path = "commands/ccchan_commands.rs"]
mod ccchan_commands;
#[path = "services/ccchan_service.rs"]
mod ccchan_service;
mod commands;
pub mod constants;
pub mod emitter;
pub mod import;
pub mod models;
pub mod pty;
pub mod repository;
pub mod services;
pub mod utils;
mod webview_reliability;

use ccchan_commands::{
    get_ccchan_pets, get_ccchan_pets_dir, get_ccchan_settings, hide_ccchan,
    is_ccchan_chat_session_alive, move_ccchan_window, open_ccchan_pets_dir,
    resize_ccchan_for_bubble, resize_ccchan_for_chat, resize_ccchan_for_menu, save_ccchan_settings,
    send_to_ccchan, show_ccchan, start_ccchan_chat, stop_ccchan_chat,
};
use ccchan_service::{CCChanService, CcChanSessionNotifier};
use commands::{
    abort_pi_rpc_session,
    ack_terminal_output,
    // Journal 命令
    add_journal_session,
    add_launch_history,
    add_project,
    add_provider,
    add_ssh_machine,
    add_ssh_project,
    add_terminal_task_queue_item,
    add_todo_subtask,
    add_workspace_project,
    add_worktree,
    adopt_terminal_session,
    batch_update_todo_status,
    browser_back,
    browser_close,
    browser_create,
    browser_forward,
    browser_navigate,
    browser_open_devtools,
    browser_reload,
    browser_set_bounds,
    browser_set_visible,
    cancel_acp_chat,
    cancel_media_run,
    cancel_terminal_launch,
    check_codex_rollout_exists,
    check_environment,
    check_ssh_connectivity,
    check_todo_reminders,
    check_workspace_project_paths,
    clean_all_broken_sessions,
    clean_session_file,
    cleanup_before_uninstall,
    cleanup_project_history,
    clear_launch_history,
    clear_layout_snapshot,
    clear_session_output,
    clear_terminal_sessions,
    clear_terminal_task_queue,
    close_layout_switcher_window,
    close_window,
    compress_history,
    compute_text_diff,
    copy_skill,
    create_auto_label,
    create_launch_profile,
    create_media_asset,
    create_media_edge,
    create_media_node,
    create_media_run,
    create_popup_terminal_window,
    create_quick_command,
    // Spec 命令
    create_spec,
    // TaskBinding 命令
    create_task_binding,
    create_terminal_session,
    // Todo 命令
    create_todo,
    create_workspace,
    debug_encode_path,
    delete_acp_chat_history,
    delete_ai_panel,
    delete_automation,
    delete_label,
    delete_launch_history,
    delete_launch_profile,
    delete_media_edge,
    delete_media_node,
    delete_memory,
    delete_plan,
    delete_quick_command,
    delete_skill,
    delete_spec,
    delete_task_binding,
    delete_task_binding_cascade,
    delete_terminal_task_queue_item,
    delete_todo,
    delete_todo_subtask,
    delete_workspace,
    delete_workspace_snapshot,
    describe_skill_market_entry,
    detect_claude_session,
    detect_resume_session,
    detect_system_provider,
    detect_tailscale_status,
    discover_wsl_distros,
    enter_fullscreen,
    enter_mini_mode,
    execute_import,
    execute_project_migration,
    execute_workspace_migration,
    exit_fullscreen,
    exit_mini_mode,
    extract_last_prompt,
    find_task_binding_by_session,
    format_memory_for_injection,
    free_comfy_memory,
    fs_copy_entry,
    fs_create_directory,
    fs_create_file,
    fs_delete_entry,
    fs_get_entry_info,
    // FileSystem 命令
    fs_list_directory,
    fs_move_entry,
    fs_read_file,
    fs_rename_entry,
    fs_write_file,
    generate_claude_md,
    get_acp_chat,
    get_ai_panel_content,
    get_all_terminal_status,
    get_app_cwd,
    get_available_shells,
    get_bridge_stats,
    get_comfy_object_info,
    get_comfy_runtime_status,
    get_comfy_system_stats,
    // Local History - 分支感知 + Worktree
    get_current_branch,
    get_data_dir_info,
    get_default_provider,
    get_display_server,
    // DeepSeek Harness（dsh）命令
    get_dsh_instance,
    get_file_branches,
    get_git_branch,
    get_git_changed_files,
    get_git_diff,
    get_git_file_statuses,
    get_git_local_branches,
    get_git_log,
    get_git_repo_info,
    get_git_status,
    get_history_config,
    get_history_watch_stats,
    // IM 外推命令
    get_im_bridge_status,
    get_journal_index,
    get_launch_profile,
    get_layout_switcher_snapshot,
    get_layout_switcher_state,
    // 日志命令
    get_log_dir,
    get_mcp_server,
    get_media_asset,
    get_media_edge,
    get_media_node,
    get_media_provider_capabilities,
    get_media_queue_snapshot,
    get_media_run,
    get_media_scheduler_snapshot,
    get_memory,
    get_memory_stats,
    // Orchestrator 命令
    get_orchestrator_port,
    get_orchestrator_status,
    get_orchestrator_token,
    get_pi_rpc_session,
    get_pi_rpc_state,
    get_plan_collaboration,
    get_plan_content,
    get_popup_tab_data,
    get_project,
    get_project_cli_hooks,
    get_provider,
    get_recent_changes,
    get_recent_journal,
    get_resource_stats,
    get_resource_tree,
    // Settings 命令
    get_settings,
    // 共享 MCP 命令
    get_shared_mcp_config,
    get_shared_mcp_status,
    get_skill,
    get_spec_content,
    get_ssh_machine,
    get_system_stats,
    get_task_binding,
    get_terminal_adoption_snapshot,
    get_terminal_daemon_client_info,
    get_terminal_output,
    get_terminal_recent_output,
    get_terminal_recovery_snapshot,
    get_terminal_replay_snapshot,
    get_terminal_task_queue,
    get_todo,
    get_todo_stats,
    get_version_content,
    // Local History - Diff
    get_version_diff,
    get_versions_diff,
    get_web_access_status,
    get_windows_build_number,
    get_workflow,
    get_workspace,
    get_workspace_snapshot,
    git_clone,
    git_fetch,
    git_pull,
    git_push,
    git_stash,
    git_stash_pop,
    handle_terminal_exit_spec,
    handle_terminal_exit_spec_by_session,
    import_shared_mcp_from_claude,
    // Wallpaper 命令
    import_wallpaper,
    init_ccpanes,
    // Local History 命令
    init_project_history,
    // Skill 命令
    install_market_skill,
    install_skill_market_entry,
    is_fullscreen,
    // Worktree 命令
    is_git_repo,
    kill_claude_process,
    kill_claude_processes,
    kill_orphan_processes,
    kill_terminal,
    kill_terminal_idempotent,
    list_acp_chat_history,
    list_acp_engines,
    list_ai_panel_history,
    list_ai_panels,
    list_all_claude_sessions,
    list_automation_runs,
    list_automations,
    // Provider 命令
    list_bundled_skills,
    list_claude_sessions,
    list_cli_tools,
    list_codex_sessions,
    // Local History - 删除文件 + 压缩
    list_deleted_files,
    // Local History - 目录级历史 + 最近更改
    list_directory_changes,
    list_dsh_instances,
    list_external_skills,
    list_file_versions,
    list_file_versions_by_branch,
    list_git_commit_files,
    list_labels,
    list_launch_history,
    list_launch_profiles,
    // MCP 配置命令
    list_mcp_servers,
    list_media_assets,
    list_media_edges,
    list_media_nodes,
    list_media_runs,
    list_memories,
    list_opencode_sessions,
    list_pi_rpc_sessions,
    // Plan 命令
    list_plans,
    list_project_quick_commands,
    list_projects,
    list_providers,
    list_quick_commands,
    list_recoverable_media_runs,
    list_session_index,
    list_skill_market_categories,
    list_skill_market_entries,
    list_skills,
    list_specs,
    // SSH Machine 命令
    list_ssh_machines,
    list_todo_activities,
    list_user_skills,
    list_wallpapers,
    list_workspace_snapshots,
    // Workspace 命令
    list_workspaces,
    list_worktree_recent_changes,
    list_worktrees,
    load_layout_snapshot,
    load_session_output,
    load_terminal_sessions,
    maximize_window,
    migrate_data_dir,
    minimize_window,
    open_browser_tab,
    open_layout_switcher_window,
    open_path_in_explorer,
    open_web_access,
    parse_import_url,
    prepare_session_context,
    preview_launch_profile_resolution,
    preview_project_migration,
    preview_workspace_migration,
    prompt_acp_chat,
    prompt_pi_rpc_session,
    prune_stale_session_outputs,
    prune_terminal_sessions,
    // Local History - 标签
    put_label,
    query_context_usage,
    query_task_bindings,
    query_todos,
    query_usage_stats,
    read_acp_image_attachment,
    read_agent_transcript_cmd,
    read_clipboard_file_paths,
    read_config_dir_info,
    read_session_state,
    reconcile_plan_collaboration,
    record_ai_panel_event,
    record_terminal_input,
    refresh_session_index,
    refresh_usage_stats,
    register_plan_child,
    register_plan_leader,
    register_plan_worker,
    release_terminal_session,
    remove_mcp_server,
    remove_project,
    remove_provider,
    remove_shared_mcp_server,
    remove_ssh_machine,
    remove_user_skill,
    remove_wallpaper,
    remove_workspace_project,
    remove_worktree,
    rename_acp_chat_history,
    rename_workspace,
    reorder_todo_subtasks,
    reorder_todos,
    reorder_workspaces,
    replay_media_run,
    resize_terminal,
    resolve_media_asset,
    resolve_terminal_path_link,
    resolve_wallpaper_asset,
    respond_acp_permission,
    respond_orchestrator_query,
    restart_comfy_runtime,
    restart_shared_mcp_server,
    restart_web_access,
    restore_file_version,
    restore_to_label,
    retry_media_run,
    retry_terminal_task_queue_item,
    rollback_project_migration,
    rollback_workspace_migration,
    run_automation_now,
    run_terminal_path_link_action,
    // Runner Registry 命令
    runner_delete_profile,
    runner_get_profile,
    runner_kill_instance,
    runner_kill_pid,
    runner_list_active_instances,
    runner_list_port_conflicts,
    runner_list_profiles,
    runner_mark_instance_exited,
    runner_plan_launch,
    runner_refresh_port_claims,
    runner_register_for_session,
    runner_register_implicit_instance,
    runner_upsert_profile,
    save_automation,
    save_layout_snapshot,
    save_layout_switcher_snapshot,
    save_layout_switcher_state,
    save_project_quick_commands,
    save_skill,
    save_spec_content,
    // Session Restore 命令
    save_terminal_sessions,
    save_workflow,
    scan_broken_sessions,
    // Process Monitor 命令
    scan_claude_processes,
    scan_workspace_directory,
    // Screenshot 命令
    screenshot_save_clipboard_image,
    screenshot_update_shortcut,
    // Memory 命令
    search_memory,
    search_project_contents,
    search_project_files,
    search_skill_market,
    set_acp_chat_mode,
    set_acp_chat_model,
    set_decorations,
    set_default_launch_profile,
    set_default_provider,
    set_hidden_terminal_sessions,
    set_media_run_priority,
    set_project_cli_hook_enabled,
    set_web_access_password,
    set_workspace_archived,
    set_workspace_project_archived,
    ssh_fs_configure_password,
    ssh_fs_create_directory,
    ssh_fs_create_file,
    ssh_fs_delete_entry,
    ssh_fs_download_file,
    ssh_fs_list_directory,
    ssh_fs_read_file,
    ssh_fs_read_image,
    ssh_fs_rename_entry,
    ssh_fs_set_permissions,
    ssh_fs_upload_file,
    ssh_fs_write_file,
    stage_media_input,
    stage_terminal_task_queue_clipboard_image,
    start_acp_chat,
    start_comfy_runtime,
    start_dsh_instance,
    start_launch_history_backfill,
    start_pi_rpc_session,
    start_shared_mcp_server,
    start_web_access,
    stop_acp_chat,
    stop_comfy_runtime,
    stop_dsh_instance,
    stop_pi_rpc_session,
    stop_project_history,
    stop_shared_mcp_server,
    stop_terminal_daemon,
    stop_web_access,
    store_memory,
    submit_to_session,
    sync_spec_tasks,
    take_pending_import,
    test_cli_launcher,
    test_im_channel,
    test_proxy,
    toggle_always_on_top,
    toggle_todo_my_day,
    toggle_todo_subtask,
    touch_launch_by_session,
    transcribe_voice_input,
    transition_media_run,
    trigger_notification,
    update_history_config,
    update_launch_last_prompt,
    update_launch_profile,
    update_launch_resume_source,
    update_launch_session_id,
    update_media_node,
    update_memory,
    update_project_alias,
    update_project_name,
    update_provider,
    update_quick_command,
    update_settings,
    update_shared_mcp_global_config,
    update_spec,
    update_ssh_machine,
    update_task_binding,
    update_task_binding_patch,
    update_terminal_task_queue,
    update_todo,
    update_todo_subtask,
    update_workspace,
    update_workspace_alias,
    update_workspace_path,
    update_workspace_project_alias,
    update_workspace_provider,
    upload_terminal_checkpoint,
    upsert_mcp_server,
    upsert_shared_mcp_server,
    write_terminal,
};
use repository::{
    Database, HistoryRepository, MediaRepository, PlanRepository, ProjectRepository,
    SessionIndexRepository, SpecRepository, TaskBindingRepository, TaskQueueRepository,
    TodoRepository, UsageStatsRepository,
};
use services::BrowserTabManager;
use services::{
    registry_from_providers, ComfyMediaAdapter, ComfyRuntimeService, DshService,
    ExternalSkillRegistry, FileSystemService, HistoryService, HistoryWatchManager, JournalService,
    LaunchHistoryService, LaunchProfileService, LayoutSnapshotService, McpConfigService,
    MediaJobWorker, MediaService, MemoryService, NotificationService, OrchestratorService,
    PiRpcEventBridge, PiRpcService, PlanArchiveService, PlanService, ProcessMonitorService,
    ProjectCliHooksService, ProjectContextService, ProjectService, ProviderService,
    QuickCommandService, ScreenshotService, SessionIndexService, SessionRestoreService,
    SettingsService, SharedMcpService, SkillMarketService, SkillService, SpecService,
    SshCredentialService, SshFileService, SshMachineService, StartLocks, SystemStatsService,
    TaskBindingService, TaskQueueService, TaskQueueWorker, TerminalBackendKind,
    TerminalBackendState, TerminalDaemonControlLink, TerminalDaemonEventBridge,
    TerminalDaemonLifecycle, TerminalService, TodoService, UninstallCleanupService,
    UsageStatsService, WebAccessLifecycle, WorkspaceService, WorktreeService,
    COMFY_LOCAL_PROVIDER_ID,
};
use std::sync::Arc;
use utils::AppPaths;

use std::sync::atomic::{AtomicBool, Ordering};
use tracing::{debug, error, info, warn};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalLifecycleEventPayload {
    session_id: String,
    #[serde(default)]
    exit_code: Option<i32>,
}

/// Keep TaskBinding terminal outcomes durable even while the frontend is not
/// listening. `session-killed` intentionally uses -1 because that event has
/// no process exit code; a later terminal-exit event can replace it.
fn record_task_binding_terminal_exit(
    service: Arc<TaskBindingService>,
    payload: &str,
    event_name: &'static str,
) {
    let payload = match serde_json::from_str::<TerminalLifecycleEventPayload>(payload) {
        Ok(payload) if !payload.session_id.trim().is_empty() => payload,
        Ok(_) => {
            warn!(event_name, "terminal lifecycle event missing sessionId");
            return;
        }
        Err(error) => {
            warn!(event_name, error = %error, "invalid terminal lifecycle event payload");
            return;
        }
    };
    let session_id = payload.session_id;
    let exit_code = payload.exit_code.unwrap_or(-1);

    tauri::async_runtime::spawn_blocking(move || {
        match service.record_terminal_exit(&session_id, exit_code) {
            Ok(Some(binding)) => debug!(
                event_name,
                session_id,
                binding_id = %binding.id,
                status = %binding.status,
                exit_code,
                "persisted TaskBinding terminal outcome"
            ),
            Ok(None) => {}
            Err(error) => warn!(
                event_name,
                session_id,
                exit_code,
                error = %error,
                "failed to persist TaskBinding terminal outcome"
            ),
        }
    });
}

#[cfg(target_os = "macos")]
const APP_MENU_PASTE_ID: &str = "cc-panes-menu-paste";
#[cfg(target_os = "macos")]
const APP_MENU_PASTE_EVENT: &str = "cc-panes://menu-paste";
#[cfg(target_os = "macos")]
static MACOS_TERMINAL_FOCUSED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
#[derive(Clone, serde::Serialize)]
struct AppMenuPastePayload {
    source: &'static str,
}
#[cfg(target_os = "macos")]
thread_local! {
    static MACOS_PASTE_KEY_MONITOR: std::cell::RefCell<
        Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    > = const { std::cell::RefCell::new(None) };
}

#[cfg(target_os = "macos")]
fn with_macos_app_menu<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    use tauri::menu::{
        AboutMetadata, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    };

    builder
        .menu(|app| {
            let app_menu = Submenu::with_items(
                app,
                "CC-Panes",
                true,
                &[
                    &PredefinedMenuItem::about(
                        app,
                        Some("About CC-Panes"),
                        Some(AboutMetadata {
                            name: Some("CC-Panes".to_string()),
                            version: Some(env!("CARGO_PKG_VERSION").to_string()),
                            ..Default::default()
                        }),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &MenuItem::with_id(app, APP_MENU_PASTE_ID, "Paste", true, None::<&str>)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            let window_menu = Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::bring_all_to_front(app, None)?,
                ],
            )?;
            window_menu.set_as_windows_menu_for_nsapp()?;
            let help_menu = Submenu::with_id_and_items(
                app,
                HELP_SUBMENU_ID,
                "Help",
                true,
                &[&PredefinedMenuItem::services(app, None)?],
            )?;
            help_menu.set_as_help_menu_for_nsapp()?;

            Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu, &help_menu])
        })
        .on_menu_event(|app, event| {
            if event.id.as_ref() == APP_MENU_PASTE_ID {
                info!("[macos-app-menu] Paste menu event intercepted");
                let _ = app.emit(APP_MENU_PASTE_EVENT, AppMenuPastePayload { source: "menu" });
            }
        })
}

#[cfg(not(target_os = "macos"))]
fn with_macos_app_menu<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn set_macos_terminal_focused(focused: bool) {
    MACOS_TERMINAL_FOCUSED.store(focused, Ordering::SeqCst);
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_macos_terminal_focused(_focused: bool) {}

#[cfg(target_os = "macos")]
fn install_macos_paste_key_monitor(app: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};

    if MACOS_PASTE_KEY_MONITOR.with(|slot| slot.borrow().is_some()) {
        return;
    }

    let block = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let event_ref = unsafe { event.as_ref() };
        if event_ref.r#type() != NSEventType::KeyDown {
            return event.as_ptr();
        }

        let flags = event_ref.modifierFlags();
        let relevant_flags = flags & NSEventModifierFlags::DeviceIndependentFlagsMask;
        if relevant_flags != NSEventModifierFlags::Command {
            return event.as_ptr();
        }

        let is_v_key = event_ref
            .charactersIgnoringModifiers()
            .as_deref()
            .map(|characters| characters.to_string().eq_ignore_ascii_case("v"))
            .unwrap_or(false)
            || event_ref.keyCode() == 9;
        if !is_v_key {
            return event.as_ptr();
        }

        if !MACOS_TERMINAL_FOCUSED.load(Ordering::SeqCst) {
            return event.as_ptr();
        }

        let Some(window) = app.get_webview_window("main") else {
            return event.as_ptr();
        };
        if !window.is_focused().unwrap_or(false) {
            return event.as_ptr();
        }

        info!("[macos-paste-key-monitor] Cmd+V intercepted; emitting app paste event");
        let _ = app.emit(
            APP_MENU_PASTE_EVENT,
            AppMenuPastePayload {
                source: "native-key-monitor",
            },
        );
        std::ptr::null_mut()
    });

    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };
    match monitor {
        Some(monitor) => {
            MACOS_PASTE_KEY_MONITOR.with(|slot| {
                *slot.borrow_mut() = Some(monitor);
            });
            info!("[boot] macOS: installed Cmd+V native paste key monitor");
        }
        None => {
            warn!("[boot] macOS: failed to install Cmd+V native paste key monitor");
        }
    }
}

/// macOS: 强制将 WKWebView 设为 NSWindow 的 firstResponder
/// 修复无边框窗口（decorations: false）下键盘输入失效的问题
#[cfg(target_os = "macos")]
fn force_webview_focus(window: &tauri::WebviewWindow) {
    // 层 1: JS eval 强制 document 获焦（同步，不依赖 with_webview 回调时序）
    let _ = window.eval("setTimeout(() => document.documentElement.focus(), 50)");

    // 层 2: 原生 ObjC（异步，通过事件循环）
    let _ = window.with_webview(|webview| unsafe {
        use objc2::runtime::NSObjectProtocol;
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSWindow};
        use objc2_web_kit::WKWebView;

        let wk_webview: &WKWebView = &*webview.inner().cast();
        let ns_window: &NSWindow = &*webview.ns_window().cast();

        // with_webview 回调应在主线程执行；万一不是，跳过原生焦点修复
        // 而不是 panic（层 1 的 JS eval 仍然生效）
        let Some(mtm) = MainThreadMarker::new() else {
            eprintln!("[macos-focus] with_webview callback not on main thread; skip native focus");
            return;
        };

        // 确保 app 激活 + 窗口为 key window。
        // `-[NSApplication activate]`（无参）是 macOS 14+ 才有的 API，而
        // minimumSystemVersion 声明 10.15；objc2 是运行时消息派发、没有编译期
        // 可用性门禁，老系统直接 unrecognized selector 崩进程——必须运行时探测。
        let app = NSApplication::sharedApplication(mtm);
        if app.respondsToSelector(objc2::sel!(activate)) {
            app.activate();
        } else {
            #[allow(deprecated)]
            app.activateIgnoringOtherApps(true);
        }
        ns_window.makeKeyAndOrderFront(None);

        // 设置 firstResponder
        let ok = ns_window.makeFirstResponder(Some(wk_webview));
        eprintln!("[macos-focus] with_webview callback executed, makeFirstResponder={ok}");
    });
}

/// 截图进行中标志（模块级），托盘/菜单 show 守卫会检查此标志
static CAPTURING: AtomicBool = AtomicBool::new(false);

fn should_close_main_window_to_tray(window: &tauri::Window) -> bool {
    if cfg!(target_os = "linux") {
        return false;
    }

    window
        .app_handle()
        .try_state::<Arc<SettingsService>>()
        .map(|settings| settings.get_settings().general.close_to_tray)
        .unwrap_or(false)
}

/// 触发截图流程：SetWindowDisplayAffinity 方案
/// Windows: 设置 WDA_EXCLUDEFROMCAPTURE → xcap 截屏 → 选区 → 裁剪保存 → 恢复 WDA_NONE
/// 非 Windows: Tauri hide → 截屏 → 选区 → 裁剪保存 → Tauri show
pub fn trigger_screenshot(app: &tauri::AppHandle, settings_service: Arc<SettingsService>) {
    use std::time::Instant;

    if CAPTURING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    // 获取主窗口 HWND（isize 可安全跨线程传递）
    #[cfg(target_os = "windows")]
    let main_hwnd: Option<isize> = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok().map(|h| h.0 as isize));

    // ★ Windows: 在主线程设置 DisplayAffinity，DWM 层面排除窗口（立即生效）
    // 窗口保持可见，Tauri 状态不变，不会出现 re-show 问题
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
        };
        if let Some(val) = main_hwnd {
            let hwnd = HWND(val as *mut std::ffi::c_void);
            unsafe {
                let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            }
            debug!("[screenshot] display affinity set to WDA_EXCLUDEFROMCAPTURE");
        }
    }

    // 非 Windows：仍用 Tauri hide
    #[cfg(not(target_os = "windows"))]
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.hide();
    }

    #[allow(unused_variables)]
    let app = app.clone();
    let retention_days = settings_service.get_settings().screenshot.retention_days;
    std::thread::spawn(move || {
        // Drop guard: 确保 CAPTURING 在 panic 或提前返回时也能重置
        struct CapturingGuard;
        impl Drop for CapturingGuard {
            fn drop(&mut self) {
                CAPTURING.store(false, Ordering::SeqCst);
            }
        }
        let _guard = CapturingGuard;

        let t0 = Instant::now();
        debug!("[screenshot] +0ms: start (display affinity set)");

        // 非 Windows：等待一帧刷新
        #[cfg(not(target_os = "windows"))]
        std::thread::sleep(std::time::Duration::from_millis(80));

        // 1. xcap 截屏到内存（Windows 上主窗口已被 DWM 排除）
        let capture = match ScreenshotService::capture_to_memory() {
            Ok(r) => r,
            Err(e) => {
                error!(
                    "[screenshot] +{}ms: capture failed: {}",
                    t0.elapsed().as_millis(),
                    e
                );
                #[cfg(target_os = "windows")]
                restore_display_affinity(main_hwnd);
                #[cfg(not(target_os = "windows"))]
                restore_main_window_tauri(&app);
                return; // _guard Drop 会自动重置 CAPTURING
            }
        };
        debug!(
            "[screenshot] +{}ms: xcap capture done ({}x{})",
            t0.elapsed().as_millis(),
            capture.image.width(),
            capture.image.height()
        );

        // 2. 显示原生选区窗口（阻塞直到用户选完或取消）
        #[cfg(target_os = "windows")]
        let selection = services::screenshot_overlay::show_selection_overlay(
            &capture.image,
            capture.monitor_x,
            capture.monitor_y,
            capture.monitor_width,
            capture.monitor_height,
        );
        #[cfg(not(target_os = "windows"))]
        let selection: Option<services::screenshot_overlay::SelectionRect> = None;

        debug!(
            "[screenshot] +{}ms: user finished selection",
            t0.elapsed().as_millis()
        );

        // 3. 如果有选区 → 从内存裁剪 + 保存 PNG + 复制路径到剪贴板
        if let Some(rect) = selection {
            debug!(
                "[screenshot] +{}ms: image ready in memory",
                t0.elapsed().as_millis()
            );
            match ScreenshotService::save_cropped(
                &capture.image,
                rect.x,
                rect.y,
                rect.w,
                rect.h,
                retention_days,
            ) {
                Ok(result) => {
                    #[cfg(target_os = "windows")]
                    copy_to_clipboard_win32(&result.file_path);
                    info!(
                        "[screenshot] +{}ms: crop + save done → {}",
                        t0.elapsed().as_millis(),
                        result.file_path
                    );
                }
                Err(e) => {
                    error!(
                        "[screenshot] +{}ms: crop failed: {}",
                        t0.elapsed().as_millis(),
                        e
                    );
                }
            }
        } else {
            debug!(
                "[screenshot] +{}ms: user cancelled",
                t0.elapsed().as_millis()
            );
        }

        // 4. 恢复 DisplayAffinity / 窗口可见性
        #[cfg(target_os = "windows")]
        restore_display_affinity(main_hwnd);
        #[cfg(not(target_os = "windows"))]
        restore_main_window_tauri(&app);

        debug!(
            "[screenshot] +{}ms: display affinity restored",
            t0.elapsed().as_millis()
        );
        // _guard Drop 会自动重置 CAPTURING
    });
}

/// Windows: 恢复 DisplayAffinity 为 WDA_NONE（截图完成后）
#[cfg(target_os = "windows")]
fn restore_display_affinity(hwnd_val: Option<isize>) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_NONE};
    if let Some(val) = hwnd_val {
        let hwnd = HWND(val as *mut std::ffi::c_void);
        unsafe {
            let _ = SetWindowDisplayAffinity(hwnd, WDA_NONE);
        }
    }
}

/// 非 Windows 平台：通过 Tauri API 恢复主窗口
#[cfg(not(target_os = "windows"))]
fn restore_main_window_tauri(app: &tauri::AppHandle) {
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.show();
        let _ = main_win.set_focus();
    }
}

/// Win32 API 直接复制文本到剪贴板
#[cfg(target_os = "windows")]
fn copy_to_clipboard_win32(text: &str) {
    use windows::Win32::Foundation::*;
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::*;
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        if OpenClipboard(None).is_err() {
            error!("[screenshot] failed to open clipboard");
            return;
        }
        let _ = EmptyClipboard();

        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let size = wide.len() * 2;

        let hmem = GlobalAlloc(GMEM_MOVEABLE, size);
        if let Ok(hmem) = hmem {
            let ptr = GlobalLock(hmem);
            if ptr.is_null() {
                // GlobalLock 失败：释放已分配的内存
                let _ = GlobalFree(Some(hmem));
            } else {
                std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr as *mut u8, size);
                let _ = GlobalUnlock(hmem);
                // SetClipboardData 成功后系统接管 hmem，失败则需手动释放
                if SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(hmem.0))).is_err() {
                    let _ = GlobalFree(Some(hmem));
                }
            }
        }
        let _ = CloseClipboard();
    }
}

// ============ 辅助函数 ============

/// Strip ANSI escape sequences from a string.
/// Handles CSI sequences like `\x1b[31m`, `\x1b[0m`, etc.
#[cfg(not(target_os = "windows"))]
fn strip_ansi_escapes(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // consume '[' if present
            if let Some(next) = chars.next() {
                if next == '[' {
                    // consume until a letter (the terminator)
                    for sc in chars.by_ref() {
                        if sc.is_ascii_alphabetic() {
                            break;
                        }
                    }
                }
                // else: lone ESC + non-'[', skip both
            }
        } else {
            result.push(c);
        }
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn append_sanitized_path_entry(dirs: &mut Vec<String>, entry: &str) {
    let trimmed = entry.trim();
    if trimmed.is_empty() || trimmed.contains("Restored session") {
        return;
    }

    let path = std::path::Path::new(trimmed);
    if !path.is_absolute() || !path.is_dir() {
        return;
    }

    if !dirs.iter().any(|existing| existing == trimmed) {
        dirs.push(trimmed.to_string());
    }
}

#[cfg(not(target_os = "windows"))]
fn recover_path_entry_from_noisy_segment(segment: &str) -> Option<&str> {
    let direct = segment.trim();
    if std::path::Path::new(direct).is_absolute() {
        return Some(direct);
    }

    direct
        .split_whitespace()
        .rev()
        .find(|token| std::path::Path::new(token).is_absolute())
}

/// Normalize shell/cache PATH output before it becomes process state.
///
/// Login shells can print status text to stdout (for example "Restored session: ...")
/// before `echo $PATH`; keep only existing absolute directories and de-duplicate them.
#[cfg(not(target_os = "windows"))]
pub(crate) fn sanitize_path_output(raw: &str) -> Option<String> {
    let stripped = strip_ansi_escapes(raw);
    let mut dirs: Vec<String> = Vec::new();

    for line in stripped.lines() {
        for segment in line.split(':') {
            if let Some(entry) = recover_path_entry_from_noisy_segment(segment) {
                append_sanitized_path_entry(&mut dirs, entry);
            }
        }
    }

    if dirs.is_empty() {
        None
    } else {
        Some(dirs.join(":"))
    }
}

/// 获取 PATH 缓存文件路径
#[cfg(not(target_os = "windows"))]
pub(crate) fn get_path_cache_file() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    home.join(crate::utils::APP_DIR_NAME)
        .join("cached_path")
        .to_string_lossy()
        .to_string()
}

/// 写 PATH 缓存文件（确保父目录存在）
#[cfg(not(target_os = "windows"))]
fn write_path_cache(file: &str, path: &str) -> std::io::Result<()> {
    let p = std::path::Path::new(file);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let path = sanitize_path_output(path).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "PATH has no valid entries",
        )
    })?;
    std::fs::write(file, path)
}

/// 从 shell 解析 PATH（10 秒超时）
#[cfg(not(target_os = "windows"))]
fn resolve_path_from_shell(shell: &str) -> Option<String> {
    let child = std::process::Command::new(shell)
        .args(["-ilc", "echo $PATH"])
        .env("CCPANES_RESOLVING_ENVIRONMENT", "1")
        .env("ZSH_TMUX_AUTOSTART", "false")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .ok()?;

    let child_pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(output)) if output.status.success() => {
            let raw = String::from_utf8_lossy(&output.stdout);
            sanitize_path_output(&raw)
        }
        _ => {
            eprintln!("[boot] shell timed out or failed, killing pid={child_pid}");
            #[cfg(unix)]
            unsafe {
                libc::kill(child_pid as i32, libc::SIGKILL);
            }
            None
        }
    }
}

/// well-known paths fallback：扫描常见目录，存在才加入
#[cfg(not(target_os = "windows"))]
fn build_fallback_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    let home_str = home.to_string_lossy();

    let mut dirs: Vec<String> = Vec::new();

    // 用户级工具目录
    let user_dirs = [
        format!("{home_str}/.cargo/bin"),
        format!("{home_str}/.local/bin"),
    ];
    for d in &user_dirs {
        append_sanitized_path_entry(&mut dirs, d);
    }

    // nvm：找最新的 node 版本目录（semver 感知，字典序会把 v9 挑赢 v20）
    let nvm_dir = std::env::var("NVM_DIR").unwrap_or_else(|_| format!("{home_str}/.nvm"));
    let nvm_versions = std::path::Path::new(&nvm_dir).join("versions/node");
    if let Some(bin) = cc_cli_adapters::nvm_node_bin_dirs(&nvm_versions).first() {
        append_sanitized_path_entry(&mut dirs, &bin.to_string_lossy());
    }

    // shell 配置才进 PATH 的包管理器目录（bun/pnpm/volta/asdf/fnm）
    for d in cc_cli_adapters::extra_unix_tool_dirs(&home) {
        append_sanitized_path_entry(&mut dirs, &d.to_string_lossy());
    }

    // 系统级目录
    let system_dirs = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/opt/local/bin",
    ];
    for d in &system_dirs {
        append_sanitized_path_entry(&mut dirs, d);
    }

    // 追加当前 PATH 去重
    if let Ok(current) = std::env::var("PATH") {
        for entry in current.split(':') {
            append_sanitized_path_entry(&mut dirs, entry);
        }
    }

    dirs.join(":")
}

/// 后台刷新 PATH 缓存 + 更新当前进程 PATH
#[cfg(not(target_os = "windows"))]
fn refresh_path_cache(cache_file: &str) {
    // $SHELL 缺失时按平台回落（macOS → /bin/zsh，回落 /bin/sh 的话
    // `-ilc` 不读 zsh 配置，抓出来的 PATH 还是残缺的）
    let shell = cc_cli_adapters::resolve_login_shell();
    if let Some(path) = resolve_path_from_shell(&shell) {
        let _ = write_path_cache(cache_file, &path);
        unsafe {
            std::env::set_var("PATH", &path);
        }
        eprintln!(
            "[boot/bg] PATH cache refreshed + process PATH updated ({} entries)",
            path.split(':').count()
        );
    }
}

/// 两层 PATH 加载：缓存 → well-known fallback（shell 全走后台）
#[cfg(not(target_os = "windows"))]
fn load_full_path() {
    let cache_file = get_path_cache_file();

    // 1. 尝试读缓存
    if let Ok(cached) = std::fs::read_to_string(&cache_file) {
        if let Some(cached) = sanitize_path_output(&cached) {
            let _ = write_path_cache(&cache_file, &cached);
            eprintln!(
                "[boot] PATH loaded from cache ({} entries)",
                cached.split(':').count()
            );
            unsafe {
                std::env::set_var("PATH", &cached);
            }
            let cache_file_bg = cache_file.clone();
            std::thread::spawn(move || refresh_path_cache(&cache_file_bg));
            return;
        }
    }

    // 2. 无缓存：立即用 well-known paths（纯 fs 扫描，<1ms）
    let path = build_fallback_path();
    eprintln!(
        "[boot] PATH set from well-known paths ({} entries), shell refresh in background",
        path.split(':').count()
    );
    unsafe {
        std::env::set_var("PATH", &path);
    }

    // 后台 spawn shell 刷新缓存 + 更新当前进程 PATH
    std::thread::spawn(move || refresh_path_cache(&cache_file));
}

/// wry/WebView2 日志限流：60s 窗口内最多放行 5 条 `tauri_runtime_wry` 记录。
/// 纯计数、不在过滤器内再打日志（避免 logger 重入）。窗口切换存在竞态但
/// 只影响个位数条目，可接受。
fn wry_log_allowed() -> bool {
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
    static WINDOW_START_MS: AtomicU64 = AtomicU64::new(0);
    static WINDOW_COUNT: AtomicU32 = AtomicU32::new(0);
    const WINDOW_MS: u64 = 60_000;
    const MAX_PER_WINDOW: u32 = 5;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let start = WINDOW_START_MS.load(Ordering::Relaxed);
    if now_ms.saturating_sub(start) >= WINDOW_MS {
        WINDOW_START_MS.store(now_ms, Ordering::Relaxed);
        WINDOW_COUNT.store(1, Ordering::Relaxed);
        return true;
    }
    WINDOW_COUNT.fetch_add(1, Ordering::Relaxed) < MAX_PER_WINDOW
}

/// 解析 `ccpanes://` 一键导入链接。返回是否命中导入链接。
///
/// `defer`：
/// - `true`（**冷启动**，setup 扫首进程 argv，此时前端未挂载）→ **只暂存 pending**，前端挂载后
///   调 `take_pending_import` 补领；不 emit（没人听）。
/// - `false`（**热态**，single-instance argv / macOS on_open_url，前端已在听）→ **只 emit**，
///   不写 pending —— 否则热态请求也留在 pending，WebView/组件重载后会重放已处理过的旧请求。
fn handle_import_url(app: &tauri::AppHandle, url: &str, defer: bool) -> bool {
    use tauri::{Emitter, Manager};
    if !crate::import::is_import_url(url) {
        return false;
    }
    // 唤醒主窗口（固定 "main"，不误聚焦 ccchan/popup）。
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    match crate::import::parse_import_url(url) {
        Ok(req) => {
            // 脱敏：只记资源类型，绝不打印含 apiKey/env 的完整 URL。
            let kind = crate::import::request_kind(&req);
            log::info!("[import] received (defer={defer}): resource={kind}");
            if defer {
                app.state::<crate::import::PendingImportStore>().set(req);
            } else {
                let _ = app.emit_to("main", "ccpanes-import", &req);
            }
        }
        Err(e) => {
            // 热态直接弹错误 toast；冷启动无监听器，只记日志（罕见的畸形冷启动链接丢提示可接受）。
            if !defer {
                let _ = app.emit_to("main", "ccpanes-import-error", e.clone());
            }
            log::warn!("[import] parse failed (defer={defer}): {e}");
        }
    }
    true
}

/// 主窗口几何的恢复与持久化。
///
/// tauri.conf.json 写死 `maximized: true`，于是每次启动都满屏——用户把窗口
/// 拖小、下次启动又变回去。这里在 setup 末尾恢复上次几何，并监听窗口事件写回。
///
/// 没有记录过（首次启动 / 旧配置）就什么都不做，保持 tauri.conf.json 的默认行为。
fn restore_main_window_geometry(app: &tauri::AppHandle) {
    use tauri::{LogicalPosition, LogicalSize, Manager};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(settings_service) = app.try_state::<Arc<SettingsService>>() else {
        return;
    };
    let saved = settings_service.get_settings().main_window;

    // maximized 未记录 = 从未保存过，保持首启默认（最大化），不要缩成 1280x800
    match saved.maximized {
        None => {}
        Some(true) => {
            let _ = window.maximize();
        }
        Some(false) => {
            let _ = window.unmaximize();
            if let (Some(width), Some(height)) = (saved.width, saved.height) {
                if width >= 1.0 && height >= 1.0 {
                    let _ = window.set_size(LogicalSize::new(width, height));
                }
            }
            // 位置单独判断：屏幕数量/分辨率可能变了，越界的坐标不如不设，
            // 让 tauri 的 center 生效，避免窗口飞到看不见的地方。
            if let (Some(x), Some(y)) = (saved.x, saved.y) {
                if position_is_visible(&window, x, y) {
                    let _ = window.set_position(LogicalPosition::new(x, y));
                }
            }
        }
    }

    spawn_main_window_geometry_watcher(app.clone(), window);
}

/// 坐标是否落在某块显示器内。多屏拔掉后旧坐标会把窗口放到不可见区域。
fn position_is_visible(window: &tauri::WebviewWindow, x: f64, y: f64) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        let pos = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        x >= pos.x - 1.0 && y >= pos.y - 1.0 && x < pos.x + size.width && y < pos.y + size.height
    })
}

/// 监听窗口移动/缩放并防抖写回。
///
/// 拖动一次窗口会连发几十个事件，每个都落盘会把磁盘打满——与终端字号缩放
/// 同一类问题，同样用「停手后写一次」。
fn spawn_main_window_geometry_watcher(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
    use tauri::WindowEvent;

    static PENDING: AtomicU64 = AtomicU64::new(0);
    const DEBOUNCE_MS: u64 = 600;

    let handle = app.clone();
    window.clone().on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_)) {
            return;
        }
        let generation = PENDING.fetch_add(1, AtomicOrdering::SeqCst) + 1;
        let handle = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(DEBOUNCE_MS));
            // 期间又来了新事件就交给后来者，避免中间态被写进配置
            if PENDING.load(AtomicOrdering::SeqCst) != generation {
                return;
            }
            persist_main_window_geometry(&handle);
        });
    });
}

fn persist_main_window_geometry(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(settings_service) = app.try_state::<Arc<SettingsService>>() else {
        return;
    };
    // 最小化时的几何没有意义，写进去下次会还原成一个畸形窗口
    if window.is_minimized().unwrap_or(false) {
        return;
    }

    let maximized = window.is_maximized().unwrap_or(false);
    let mut size = None;
    let mut position = None;

    // 最大化状态下的 size/position 是屏幕尺寸，不该覆盖用户上次的还原态尺寸
    if !maximized {
        if let Ok(scale) = window.scale_factor() {
            if let Ok(inner_size) = window.inner_size() {
                size = Some(inner_size.to_logical::<f64>(scale));
            }
            if let Ok(outer_position) = window.outer_position() {
                position = Some(outer_position.to_logical::<f64>(scale));
            }
        }
    }

    if let Err(error) = settings_service.update_main_window(|main_window| {
        main_window.maximized = Some(maximized);
        if let Some(size) = size {
            main_window.width = Some(size.width);
            main_window.height = Some(size.height);
        }
        if let Some(position) = position {
            main_window.x = Some(position.x);
            main_window.y = Some(position.y);
        }
    }) {
        warn!(error = %error, "failed to persist main window geometry");
    }
}

// ============ 应用入口 ============

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let boot_t0 = std::time::Instant::now();
    // 早期启动打点收集（log 插件尚未初始化，先存到 Vec，setup 后 replay 到 info!）
    let mut boot_marks: Vec<(u128, String)> = Vec::new();
    macro_rules! boot_mark {
        ($msg:literal) => {{
            let ms = boot_t0.elapsed().as_millis();
            eprintln!("[boot] +{}ms: {}", ms, $msg);
            boot_marks.push((ms, $msg.to_string()));
        }};
        ($fmt:expr, $($arg:tt)*) => {{
            let ms = boot_t0.elapsed().as_millis();
            let msg = format!($fmt, $($arg)*);
            eprintln!("[boot] +{}ms: {}", ms, msg);
            boot_marks.push((ms, msg));
        }};
    }

    // 0. Panic hook — 将 panic 信息写入 crash.log（诊断兜底）
    {
        use std::io::Write as _;
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // 写入 crash.log
            let crash_dir = crate::utils::app_config_dir();
            let _ = std::fs::create_dir_all(&crash_dir);
            let crash_log = crash_dir.join("crash.log");
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&crash_log)
            {
                let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
                let _ = writeln!(f, "[{timestamp}] PANIC: {info}");
                let bt = std::backtrace::Backtrace::force_capture();
                let _ = writeln!(f, "{bt}");
            }
            // 调用默认 hook（打印到 stderr）
            default_hook(info);
        }));
    }
    boot_mark!("panic hook installed");

    // 0.5 macOS/Linux: 两层 PATH 加载（缓存 → well-known fallback，shell 全走后台）
    #[cfg(not(target_os = "windows"))]
    {
        load_full_path();
    }
    boot_mark!("PATH loaded");

    // 1. 先加载设置，取得 data_dir + log_level
    let settings_service = Arc::new(SettingsService::new());
    let settings = settings_service.get_settings();
    let data_dir = settings.general.data_dir;
    let log_level = match settings.general.log_level.as_str() {
        "error" => log::LevelFilter::Error,
        "warn" => log::LevelFilter::Warn,
        "debug" => log::LevelFilter::Debug,
        "trace" => log::LevelFilter::Trace,
        _ => log::LevelFilter::Info,
    };

    boot_mark!("settings loaded (log_level={:?})", log_level);

    // 1.5 如果代理已启用，设置进程级环境变量（影响 updater 等 HTTP 请求）
    if settings.proxy.enabled && !settings.proxy.host.is_empty() {
        for (key, value) in settings.proxy.to_env_vars() {
            // SAFETY: 在 main 线程启动阶段调用，此时无其他线程读取这些变量
            unsafe {
                std::env::set_var(&key, &value);
            }
        }
    }

    // 2. 构造路径管理器
    let app_paths = Arc::new(AppPaths::new(data_dir));
    boot_mark!("app_paths initialized");

    // 3. 各服务用 app_paths 初始化
    boot_mark!("initializing database...");
    let db = match Database::new(app_paths.database_path()) {
        Ok(db) => Arc::new(db),
        Err(e) => {
            error!(
                "Database initialization failed: {}, trying in-memory fallback",
                e
            );
            Arc::new(Database::new_fallback().unwrap_or_else(|e2| {
                panic!(
                    "Database initialization completely failed (including fallback): {}",
                    e2
                );
            }))
        }
    };
    boot_mark!("database initialized");
    let project_repo = Arc::new(ProjectRepository::new(db.clone()));
    let media_repository = Arc::new(MediaRepository::new(db.clone()));
    let media_service = Arc::new(MediaService::with_media_root(
        media_repository,
        app_paths.media_dir(),
    ));
    let comfy_runtime_service = Arc::new(ComfyRuntimeService::new());
    match project_repo.migrate_project_identities() {
        Ok(report) if report.projects_updated > 0 || report.duplicates_removed > 0 => info!(
            updated = report.projects_updated,
            removed = report.duplicates_removed,
            "[project-identity] SQLite projects migrated"
        ),
        Ok(_) => {}
        Err(error) => warn!(
            "[project-identity] SQLite project migration failed: {}",
            error
        ),
    }
    let history_repo = Arc::new(HistoryRepository::new(db.clone()));
    let todo_repo = Arc::new(TodoRepository::new(db.clone()));
    let spec_repo = Arc::new(SpecRepository::new(db.clone()));
    let task_binding_repo = Arc::new(TaskBindingRepository::new(db.clone()));
    let task_queue_repo = Arc::new(TaskQueueRepository::new(db.clone()));
    let plan_repo = Arc::new(PlanRepository::new(db.clone()));
    let usage_stats_repo = Arc::new(UsageStatsRepository::new(db.clone()));
    let session_index_repo = Arc::new(SessionIndexRepository::new(db.clone()));
    let ai_panel_repo = Arc::new(cc_panes_core::repository::AiPanelRepository::new(
        db.clone(),
    ));
    let mcp_tool_call_stats_repo = Arc::new(
        cc_panes_core::repository::McpToolCallStatsRepository::new(db.clone()),
    );
    let launch_history_service = Arc::new(LaunchHistoryService::new(history_repo));
    let provider_service = Arc::new(ProviderService::new(app_paths.providers_path()));
    let todo_service = Arc::new(TodoService::new(todo_repo));
    let task_binding_service = Arc::new(TaskBindingService::new(task_binding_repo));
    let pi_rpc_service = Arc::new(PiRpcService::new());
    let acp_chat_service = Arc::new(services::AcpChatService::new(
        app_paths.data_dir().join("agent-chats"),
    ));
    let automation_service = Arc::new(services::AutomationService::new(
        app_paths.data_dir().join("automations"),
        acp_chat_service.clone(),
        app_paths.clone(),
    ));
    let acp_chat_notify = acp_chat_service.clone();
    let task_queue_service = Arc::new(TaskQueueService::new(
        task_queue_repo,
        app_paths.task_queue_images_dir(),
        ScreenshotService::screenshots_dir(),
    ));
    if let Err(error) = task_queue_service.set_global_enabled(
        settings_service.get_settings().terminal.task_queue_enabled,
        chrono::Utc::now().timestamp_millis(),
    ) {
        warn!(error = %error, "failed to initialize task queue runtime setting");
    }
    if let Err(error) = task_queue_service.prune_unreferenced_images() {
        warn!(error = %error, "failed to prune unreferenced task queue images");
    }
    let plan_archive_service = Arc::new(PlanArchiveService::new(plan_repo));
    let usage_stats_service = Arc::new(UsageStatsService::new_with_provider_and_settings(
        usage_stats_repo,
        launch_history_service.clone(),
        provider_service.clone(),
        settings_service.clone(),
    ));
    let spec_service = Arc::new(SpecService::new(spec_repo, todo_service.clone()));
    let project_service = Arc::new(ProjectService::new(project_repo));
    let history_service = Arc::new(HistoryService::new());
    let history_watch_manager = Arc::new(HistoryWatchManager::new(history_service.clone()));
    history_watch_manager.set_enabled(settings_service.get_settings().local_history.enabled);
    let project_context_service = Arc::new(ProjectContextService::new());
    let journal_service = Arc::new(JournalService::new(app_paths.workspaces_dir()));
    let worktree_service = Arc::new(WorktreeService::new());
    let workspace_service = Arc::new(WorkspaceService::new(app_paths.workspaces_dir()));
    match workspace_service.migrate_project_identities() {
        Ok(report) if report.workspaces_updated > 0 => info!(
            workspaces = report.workspaces_updated,
            updated = report.projects_updated,
            removed = report.duplicates_removed,
            backups = report.backups_created,
            csv = report.csv_regenerated,
            "[project-identity] workspace projects migrated"
        ),
        Ok(_) => {}
        Err(error) => warn!(
            "[project-identity] workspace project migration failed: {}",
            error
        ),
    }
    // 默认工作空间：缺失自动创建（锚点为应用数据目录下的 workspaces/default）
    match workspace_service.ensure_default_workspace() {
        Ok(Some(ws)) => info!("[workspace] default workspace ensured at {:?}", ws.path),
        Ok(None) => {}
        Err(e) => warn!("[workspace] ensure default workspace failed: {}", e),
    }
    // Media nodes and assets resolve their project root through the same
    // workspace registry used by the terminal. IDs remain stable across
    // workspace renames; the client-provided path is never trusted.
    media_service.set_workspace_service(workspace_service.clone());
    let session_index_service = Arc::new(SessionIndexService::new_with_settings(
        session_index_repo,
        launch_history_service.clone(),
        workspace_service.clone(),
        settings_service.clone(),
    ));
    // Keep the desktop surface aligned with the shared adapter registry. This
    // also drives the CLI installation status rendered by the settings UI.
    let cli_registry = Arc::new(cc_cli_adapters::CliToolRegistry::with_builtin_adapters());
    let external_skill_registry = Arc::new(ExternalSkillRegistry::new(cli_registry.clone()));
    let launch_profile_service = Arc::new(LaunchProfileService::new_with_external_skill_registry(
        app_paths.launch_profiles_path(),
        external_skill_registry.clone(),
    ));
    let quick_command_service = Arc::new(QuickCommandService::new(app_paths.quick_commands_path()));
    // 「本轮已富通知」标记注册表：trigger_notification 打标，状态机 turn_end 兜底查标去重
    let turn_notify_registry = Arc::new(services::TurnNotifyRegistry::new());
    let notification_service = Arc::new(NotificationService::new(turn_notify_registry.clone()));
    let notification_for_acp = notification_service.clone();
    let settings_for_acp = settings_service.clone();
    let ccchan_service = Arc::new(CCChanService::new(
        settings_service.clone(),
        app_paths.clone(),
    ));
    let mcp_config_service = Arc::new(McpConfigService::new());
    let skill_service = Arc::new(SkillService::new());
    let skill_market_service = Arc::new(SkillMarketService::new(
        app_paths.skills_dir(),
        app_paths.user_skills_dir(),
    ));
    let plan_service = Arc::new(PlanService::new());
    let filesystem_service = Arc::new(FileSystemService::new());
    let project_cli_hooks_service = Arc::new(ProjectCliHooksService::new(cli_registry.clone()));
    let uninstall_cleanup_service = Arc::new(UninstallCleanupService::new(cli_registry.clone()));
    let ssh_credential_service = Arc::new(SshCredentialService::new());
    let terminal_service = Arc::new(TerminalService::new(
        settings_service.clone(),
        provider_service.clone(),
        app_paths.clone(),
        cli_registry.clone(),
        project_cli_hooks_service.clone(),
        ssh_credential_service.clone(),
    ));
    // 注入 Spec 服务到 Terminal 服务（终端启动时自动注入 spec prompt）
    terminal_service.set_spec_service(spec_service.clone());
    terminal_service.set_launch_profile_service(launch_profile_service.clone());
    terminal_service.set_workspace_service(workspace_service.clone());
    let terminal_backend_state = Arc::new(TerminalBackendState::from_env_or_in_process(
        terminal_service.clone(),
        app_paths.as_ref(),
    ));

    let memory_service = Arc::new(
        MemoryService::new(app_paths.data_dir().join("memory.db")).unwrap_or_else(|e| {
            error!("MemoryService init failed: {}, using in-memory fallback", e);
            MemoryService::new_memory().expect("MemoryService fallback failed")
        }),
    );

    let ssh_machine_service = Arc::new(SshMachineService::with_connection_service(
        app_paths.data_dir().join("ssh-machines.json"),
        ssh_credential_service.clone(),
        terminal_service.ssh_connection_service(),
    ));
    let ssh_file_service = Arc::new(SshFileService::new(
        ssh_machine_service.clone(),
        terminal_service.ssh_connection_service(),
    ));

    let process_monitor_service = Arc::new(ProcessMonitorService::new());
    let system_stats_service = Arc::new(SystemStatsService::new());

    let runner_repository = Arc::new(cc_panes_core::repository::RunnerRepository::new(db.clone()));
    let runner_service = Arc::new(cc_panes_core::services::RunnerService::new(
        runner_repository,
        process_monitor_service.clone(),
    ));

    let shared_mcp_service = Arc::new(SharedMcpService::new(&app_paths));
    let dsh_service = Arc::new(DshService::new(&app_paths));

    let session_restore_service =
        Arc::new(SessionRestoreService::new(db.clone(), app_paths.clone()));
    let layout_snapshot_service = Arc::new(LayoutSnapshotService::new(db.clone()));

    let popup_data_store = commands::PopupDataStore::default();
    let layout_switcher_snapshot_store = commands::LayoutSwitcherSnapshotStore::default();
    let orchestrator_service = Arc::new(OrchestratorService::new(app_paths.as_ref()));
    let wallpaper_service = Arc::new(cc_panes_core::services::WallpaperService::new(
        app_paths.wallpapers_dir(),
    ));
    let start_locks = Arc::new(StartLocks::default());
    let web_access_lifecycle = Arc::new(WebAccessLifecycle::default());
    boot_mark!("all services created");

    // 保存引用用于退出时清理
    let terminal_cleanup = terminal_service.clone();
    let history_cleanup = history_service.clone();
    let workspace_cleanup = workspace_service.clone();
    let shared_mcp_cleanup = shared_mcp_service.clone();
    let session_restore_cleanup = session_restore_service.clone();
    let usage_stats_cleanup = usage_stats_service.clone();
    let web_access_cleanup = web_access_lifecycle.clone();
    let orchestrator_cleanup = orchestrator_service.clone();
    let pi_rpc_cleanup = pi_rpc_service.clone();
    let acp_chat_cleanup = acp_chat_service.clone();

    boot_mark!("building tauri app...");
    with_macos_app_menu(tauri::Builder::default())
        // 单实例锁必须最先注册：残留旧实例与新实例共享 daemon/data.db 时会互相
        // 误杀会话（孤儿对账）、互相覆盖持久化状态。锁按 app identifier 派生，
        // dev（com.ccpanes.dev）与 release（com.ccpanes.app）仍可并存。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Manager;
            // 脱敏：argv 可能含 ccpanes:// 导入链接（内嵌 apiKey），不整体打印。
            log::info!("[single-instance] second launch blocked ({} args)", argv.len());
            // deep-link 在 Windows/Linux 通过第二次启动的 argv 传入 ccpanes:// URL。
            let mut handled = false;
            for arg in &argv {
                if handle_import_url(app, arg, false) {
                    handled = true;
                }
            }
            if !handled {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log_level)
                // wry/WebView2 错误限流：WebView 失效时（如隐藏窗口被系统挂起）
                // 每条 emit 都会让 wry 记一条 ERROR，且日志本身还有 Webview target
                // 会再 emit 回失效 WebView，形成自放大洪水（实测 13 条/秒、
                // 10MB 日志每十几分钟滚动一次并烧满 CPU）。这里对该 target 限速，
                // 洪水最多退化为每分钟几条。
                .filter(|metadata| {
                    !metadata.target().starts_with("tauri_runtime_wry") || wry_log_allowed()
                })
                .max_file_size(10_000_000) // 10MB 单文件上限
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .manage(app_paths)
        .manage(project_service)
        .manage(media_service)
        .manage(comfy_runtime_service)
        .manage(terminal_service)
        .manage(pi_rpc_service)
        .manage(acp_chat_service)
        .manage(automation_service.clone())
        .manage(terminal_backend_state)
        .manage(launch_history_service)
        .manage(usage_stats_service)
        .manage(session_index_service)
        .manage(history_service)
        .manage(history_watch_manager)
        .manage(project_cli_hooks_service)
        .manage(uninstall_cleanup_service)
        .manage(project_context_service)
        .manage(journal_service)
        .manage(worktree_service)
        .manage(workspace_service)
        .manage(settings_service)
        .manage(provider_service)
        .manage(launch_profile_service)
        .manage(quick_command_service)
        .manage(notification_service)
        .manage(turn_notify_registry)
        .manage(ccchan_service)
        .manage(todo_service)
        .manage(task_binding_service)
        .manage(task_queue_service)
        .manage(ai_panel_repo)
        .manage(mcp_tool_call_stats_repo)
        .manage(spec_service)
        .manage(mcp_config_service)
        .manage(skill_service)
        .manage(skill_market_service)
        .manage(external_skill_registry)
        .manage(plan_service)
        .manage(plan_archive_service)
        .manage(filesystem_service)
        .manage(memory_service)
        .manage(ssh_machine_service)
        .manage(ssh_file_service)
        .manage(process_monitor_service)
        .manage(system_stats_service)
        .manage(runner_service)
        .manage(start_locks)
        .manage(web_access_lifecycle.clone())
        .manage(shared_mcp_service.clone())
        .manage(dsh_service.clone())
        .manage(session_restore_service)
        .manage(layout_snapshot_service)
        .manage(popup_data_store)
        .manage(layout_switcher_snapshot_store)
        .manage(orchestrator_service.clone())
        .manage(wallpaper_service)
        .manage(Arc::new(BrowserTabManager::default()))
        .manage(cli_registry)
        .manage(crate::import::PendingImportStore::default())
        .setup(move |app| {
            // Automations 调度循环（30s tick，cron 到期派 headless ACP 会话）。
            automation_service.start_scheduler(app.handle().clone());

            // ACP chat 回合结束/失败 → 桌面通知（走通用 trigger 闸门：
            // enabled / only_when_unfocused / 10s dedupe）。
            {
                let notification = notification_for_acp.clone();
                let settings = settings_for_acp.clone();
                let handle = app.handle().clone();
                acp_chat_notify.set_turn_notifier(Box::new(move |notice| {
                    let (kind, title) = if notice.is_error {
                        ("agent_chat_error", "❗ Agent Chat")
                    } else {
                        ("agent_chat_turn_end", "✅ Agent Chat")
                    };
                    let body: String = format!("{}: {}", notice.engine_id, notice.detail)
                        .chars()
                        .take(120)
                        .collect();
                    let _ = notification.trigger(
                        &handle,
                        &settings,
                        services::NotificationRequest {
                            kind: kind.to_string(),
                            title: title.to_string(),
                            body: Some(body),
                            source: Some("agent-chat".to_string()),
                            scope: Some("session".to_string()),
                            dedupe_key: Some(format!("acp:{}:{kind}", notice.chat_id)),
                            group_key: None,
                            only_when_unfocused: None,
                            metadata: None,
                            session_id: None,
                            requires_input: None,
                            input_placeholder: None,
                        },
                    );
                }));
            }

            // ---- deep-link：运行时注册 scheme + 监听 macOS/Linux 的 on_open_url ----
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // dev 构建注册 ccpanes-dev（release 由安装包声明的 ccpanes 生效）。
                #[cfg(debug_assertions)]
                if let Err(e) = app.deep_link().register("ccpanes-dev") {
                    log::warn!("[import] register ccpanes-dev scheme failed: {e}");
                }
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_import_url(&handle, url.as_str(), false);
                    }
                });
            }

            // 冷启动（应用原本关着）：Windows/Linux 下点击链接会以首进程 argv 传入 URL，
            // 此时前端未挂载，事件会丢——这里在启动时扫一遍 argv 存进 PendingImportStore，
            // 前端挂载后调 take_pending_import 补领。
            {
                let handle = app.handle().clone();
                for arg in std::env::args().skip(1) {
                    handle_import_url(&handle, &arg, true);
                }
            }

            // Replay 早期启动打点到日志文件（此时 tauri-plugin-log 已初始化）
            info!("[boot] === CC-Panes starting ===");
            for (ms, msg) in &boot_marks {
                info!("[boot] +{}ms: {}", ms, msg);
            }
            info!(
                "[boot] +{}ms: setup callback entered",
                boot_t0.elapsed().as_millis()
            );

            if let Ok(resource_dir) = app.path().resource_dir() {
                app.state::<Arc<TerminalService>>()
                    .set_sidecar_resource_dir(resource_dir);
            }

            // ---- 升级已注入项目的旧格式 hook 命令（不会给未注入项目新增 hook）----
            {
                let project_service = app.state::<Arc<ProjectService>>();
                let hooks_service = app.state::<Arc<ProjectCliHooksService>>();
                match project_service.list_projects() {
                    Ok(projects) => {
                        for project in projects {
                            match hooks_service.upgrade_existing_project_hooks(&project.path) {
                                Ok(count) if count > 0 => info!(
                                    project = %project.path,
                                    tools = count,
                                    "[cli-hooks] upgraded guarded hook commands"
                                ),
                                Ok(_) => {}
                                Err(error) => warn!(
                                    project = %project.path,
                                    error = %error,
                                    "[cli-hooks] startup hook upgrade skipped"
                                ),
                            }
                        }
                    }
                    Err(error) => warn!(
                        error = %error,
                        "[cli-hooks] unable to list projects for startup hook upgrade"
                    ),
                }
            }

            // ---- 提取打包的 .claude/ 配置到数据目录（Release 模式）----
            {
                let paths = app.state::<Arc<AppPaths>>();
                match app.path().resource_dir() {
                    Ok(resource_dir) => {
                        let t_extract = std::time::Instant::now();
                        paths.extract_bundled_claude_config(&resource_dir);
                        info!(
                            "[boot] bundled config extraction took {}ms",
                            t_extract.elapsed().as_millis()
                        );

                        // ---- 物化内置 Skill 到 CC-Panes 自己的目录 ----
                        // 只写 <data_dir>/skills/builtin，各 CLI 在启动时按会话挂载
                        // （Claude `--plugin-dir` / Codex `-c skills.config=`），
                        // 用户的 ~/.claude 与 ~/.codex 零写入。
                        let t_skill = std::time::Instant::now();
                        let registry = app.state::<Arc<cc_cli_adapters::CliToolRegistry>>();
                        let svc = cc_panes_core::services::DefaultSkillService::new(
                            resource_dir
                                .join("resources")
                                .join("claude-bundle")
                                .join("default-skills"),
                        );
                        match svc.materialize_managed_bundle(
                            &paths.builtin_skills_dir(),
                            env!("CARGO_PKG_VERSION"),
                        ) {
                            Ok(written) => info!(
                                "[boot] materialized {} bundled skills into {} ({}ms)",
                                written.len(),
                                paths.builtin_skills_dir().display(),
                                t_skill.elapsed().as_millis()
                            ),
                            // 物化失败 = 本次启动的会话拿不到内置 skill。必须可见，
                            // 不能静默——否则表现为「skill 悄悄全没了」且无任何线索。
                            Err(error) => warn!(
                                "[boot] failed to materialize bundled skills into {}: {}",
                                paths.builtin_skills_dir().display(),
                                error
                            ),
                        }

                        // ---- 一次性回收旧版本写进用户 CLI Home 的残留 ----
                        // 只删内容哈希能证明是我们历史发布物的文件；用户手改过的、
                        // 自建的同前缀 skill 一律保留（见 default_skill_service 顶部说明）。
                        let report_path = paths
                            .skills_dir()
                            .join(cc_panes_core::services::LEGACY_CLEANUP_REPORT_FILE_NAME);
                        match svc.cleanup_legacy_injected_once(registry.inner(), &report_path) {
                            Ok(Some(report)) => info!(
                                "[boot] legacy skill cleanup: removed {}, preserved {}, failed {}",
                                report.removed.len(),
                                report.preserved.len(),
                                report.failed.len()
                            ),
                            Ok(None) => {}
                            Err(error) => {
                                warn!("[boot] legacy skill cleanup failed: {}", error)
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[setup] Failed to resolve resource_dir, skill injection skipped: {}",
                            e
                        );
                    }
                }
            }

            info!(
                "[boot] +{}ms: bundled config extracted",
                boot_t0.elapsed().as_millis()
            );

            let daemon_control_link = Arc::new(TerminalDaemonControlLink::new(app.handle().clone()));
            app.manage(daemon_control_link.clone());

            // ---- terminal daemon lifecycle（设置开关或 env 覆盖）----
            let daemon_enabled_by_settings = app
                .state::<Arc<SettingsService>>()
                .get_settings()
                .terminal
                .daemon_enabled;
            if TerminalDaemonLifecycle::enabled_from_env() || daemon_enabled_by_settings {
                let backend_state = app.state::<Arc<TerminalBackendState>>();
                if backend_state.kind() != TerminalBackendKind::Daemon {
                    let paths = app.state::<Arc<AppPaths>>();
                    let resource_dir = app.path().resource_dir().ok();
                    let config_path = app
                        .state::<Arc<SettingsService>>()
                        .config_path()
                        .to_path_buf();
                    match TerminalDaemonLifecycle::connect_or_start(
                        paths.inner().as_ref(),
                        resource_dir.as_deref(),
                        &config_path,
                    ) {
                        Ok(client) => {
                            backend_state.try_enable_daemon(client);
                            info!("[boot] terminal daemon backend enabled");
                        }
                        Err(error) => {
                            warn!(
                                error = %error,
                                "[boot] terminal daemon unavailable; keeping in-process terminal backend"
                            );
                        }
                    }
                }
            }
            // daemon 模式（含 env 直连与刚启用两种路径）挂桌面控制链路，
            // 供 daemon 统计桌面客户端数、前端孤儿对账做多实例 fail-closed
            if let Some(client) = app
                .state::<Arc<TerminalBackendState>>()
                .daemon_client()
            {
                daemon_control_link.replace_client(client);
            }

            // ---- 出生凭证存量回填 ----
            // 历史上 orchestrator 的 launch_task 路径从不写凭证，这些会话（实测绝大多数
            // 是 wsl/codex worker）在重启后被 identity-mismatch 永久拦下。daemon 就绪后
            // 做一次性回填：对「有观测行但无凭证行」的会话向 daemon 反查并补写。
            // 幂等；死会话查不到凭证，跳过。失败只 warn，不阻塞启动。
            {
                let backend_state = app.state::<Arc<TerminalBackendState>>().inner().clone();
                let restore_svc = app.state::<Arc<SessionRestoreService>>().inner().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    match cc_panes_core::services::backfill_missing_provenance(
                        backend_state.backend().as_ref(),
                        restore_svc.as_ref(),
                    ) {
                        Ok(report) if report.missing > 0 => {
                            info!(
                                missing = report.missing,
                                backfilled = report.backfilled,
                                skipped_dead = report.skipped_dead,
                                failed = report.failed,
                                "[boot] terminal session provenance backfill done"
                            );
                        }
                        Ok(_) => {}
                        Err(error) => {
                            warn!(error = %error, "[boot] terminal session provenance backfill failed");
                        }
                    }
                });
            }

            // ---- Web 端访问服务 lifecycle ----
            {
                let settings_svc = app.state::<Arc<SettingsService>>();
                let all_settings = settings_svc.get_settings();
                let settings = all_settings.web_access;
                let web_access = app.state::<Arc<WebAccessLifecycle>>();
                let paths = app.state::<Arc<AppPaths>>();
                let resource_dir = app.path().resource_dir().ok();
                match web_access.start(
                    paths.inner().as_ref(),
                    resource_dir.as_deref(),
                    &settings,
                    all_settings.terminal.daemon_enabled,
                ) {
                    Ok(status) => {
                        info!(
                            url = %status.url,
                            running = status.running,
                            enabled = status.enabled,
                            "Web access lifecycle initialized"
                        );
                        if settings.auto_open && status.running {
                            use tauri_plugin_opener::OpenerExt;
                            if let Err(error) = app.opener().open_url(status.url, None::<&str>) {
                                warn!(error = %error, "failed to auto-open Web access URL");
                            }
                        }
                    }
                    Err(error) => {
                        warn!(error = %error, "Web access lifecycle failed to start");
                    }
                }
            }

            // ---- 强制关闭原生窗口装饰（兜底：防 tauri.dev.conf.json 配置合并丢失 decorations: false）----
            // macOS 用 traffic light 原生装饰，不强制；只对 Windows / Linux 兜底。
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.set_decorations(false);
            }

            webview_reliability::install_main_webview_process_failed_handler(app.handle())?;

            // ---- 注册 updater 插件（需在 setup 中注册以访问 app handle）----
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // ---- 注入 EventEmitter 和 SessionNotifier（setup 中才有 AppHandle）----
            {
                use emitter::{TauriEmitter, TauriSessionNotifier};
                let app_handle = app.handle().clone();
                let claim_event_handle = app_handle.clone();
                cc_panes_core::services::set_claim_lost_hook(Box::new(move |session_id| {
                    let _ = claim_event_handle.emit(
                        "terminal-claim-lost",
                        serde_json::json!({ "sessionId": session_id }),
                    );
                }));
                let history_watch_manager = app
                    .state::<Arc<HistoryWatchManager>>()
                    .inner()
                    .clone();
                app.manage(Arc::new(TerminalDaemonEventBridge::new(
                    app_handle.clone(),
                    history_watch_manager.clone(),
                )));
                let tauri_emitter: std::sync::Arc<dyn cc_panes_core::events::EventEmitter> =
                    Arc::new(TauriEmitter::new(app_handle.clone()));

                // 注入到 TerminalService
                let term_svc = app.state::<Arc<TerminalService>>();
                term_svc.set_emitter(tauri_emitter.clone());
                let tb_svc = app.state::<Arc<TaskBindingService>>();
                tb_svc.set_emitter(tauri_emitter.clone());
                app.manage(Arc::new(PiRpcEventBridge::new(
                    app_handle.clone(),
                    app.state::<Arc<PiRpcService>>().inner().clone(),
                    tb_svc.inner().clone(),
                )));
                // TaskBinding 的终态不再依赖 WebView 的事件监听：窗口刷新、失焦或
                // 自愈期间也能持久化已派发任务的退出结果。session-killed 覆盖本地
                // kill 路径，terminal-exit 覆盖自然退出与 daemon 事件桥接路径。
                {
                    use tauri::Listener;
                    let exit_service = tb_svc.inner().clone();
                    app.listen(
                        cc_panes_core::constants::events::TERMINAL_EXIT,
                        move |event| {
                            record_task_binding_terminal_exit(
                                exit_service.clone(),
                                event.payload(),
                                cc_panes_core::constants::events::TERMINAL_EXIT,
                            );
                        },
                    );
                    let killed_service = tb_svc.inner().clone();
                    app.listen(
                        cc_panes_core::constants::events::SESSION_KILLED,
                        move |event| {
                            record_task_binding_terminal_exit(
                                killed_service.clone(),
                                event.payload(),
                                cc_panes_core::constants::events::SESSION_KILLED,
                            );
                        },
                    );
                }
                let notif_svc = app.state::<Arc<NotificationService>>();
                let settings_svc = app.state::<Arc<SettingsService>>();
                let launch_history_svc = app.state::<Arc<LaunchHistoryService>>();
                let ccchan_svc = app.state::<Arc<CCChanService>>();
                ccchan_svc.set_app_handle(app_handle.clone());
                let base_notifier: Arc<dyn cc_panes_core::events::SessionNotifier> =
                    Arc::new(TauriSessionNotifier::new(
                        app_handle.clone(),
                        notif_svc.inner().clone(),
                        settings_svc.inner().clone(),
                        launch_history_svc.inner().clone(),
                        history_watch_manager,
                    ));
                let session_notifier: Arc<dyn cc_panes_core::events::SessionNotifier> = Arc::new(
                    CcChanSessionNotifier::new(base_notifier, ccchan_svc.inner().clone()),
                );
                term_svc.set_notifier(session_notifier.clone());
                // daemon 模式下 PTY 在 daemon 进程，上面这个 notifier 永远不会被本地
                // TerminalService 调到。托管进 state，让 control link 收到 daemon 转发的
                // 副作用事件时复用同一实现（行为与本地 PTY 模式一致）。
                app.manage(session_notifier);

                if ccchan_svc.settings().window_visible {
                    if let Err(error) = ccchan_svc.show_window(&app_handle) {
                        warn!("[ccchan] failed to show startup window: {}", error);
                    }
                }

                // ---- 启动 workspace 目录监控 ----
                let ws_svc = app.state::<Arc<WorkspaceService>>();
                ws_svc.start_watcher(tauri_emitter);
            }

            // ---- 确定性 resume id 绑定：监听 terminal-resume-id-detected ----
            // Claude 发号 / Codex OSC 标题捕获到的 resume id 经此落库并转发前端。
            {
                use tauri::Listener;
                let app_handle = app.handle().clone();
                let lh_svc = app.state::<Arc<LaunchHistoryService>>().inner().clone();
                app.listen(
                    cc_panes_core::constants::events::TERMINAL_RESUME_ID_DETECTED,
                    move |event| {
                        match serde_json::from_str::<services::ResumeIdDetectedPayload>(
                            event.payload(),
                        ) {
                            Ok(payload) => {
                                let app_handle = app_handle.clone();
                                let lh_svc = lh_svc.clone();
                                tauri::async_runtime::spawn(services::bind_resume_id(
                                    app_handle, lh_svc, payload,
                                ));
                            }
                            Err(error) => {
                                warn!(error = %error, "terminal-resume-id-detected: invalid payload");
                            }
                        }
                    },
                );
            }

            // ---- 一次性补救历史遗留的 Codex 记录（resume_session_id 为 null）----
            // 本修复前经 orchestrator 启动的 Codex 从未回填 resume id，导致旧会话 reload 不能恢复。
            // 用 marker 文件确保只跑一次；后台 spawn，不阻塞启动。
            {
                // v3：补救过程增加可观测日志，并且仅在无扫描/写库错误时写 marker。
                // v2 marker 可能由旧二进制写入，不能再作为本轮补救已成功的证据。
                let marker = app
                    .state::<Arc<AppPaths>>()
                    .runtime_dir()
                    .join(".codex-null-rescued-v3");
                if !marker.exists() {
                    let app_handle = app.handle().clone();
                    let lh_svc = app.state::<Arc<LaunchHistoryService>>().inner().clone();
                    tauri::async_runtime::spawn(async move {
                        let summary = services::rescue_null_codex_records(app_handle, lh_svc).await;
                        if summary.has_errors() {
                            warn!(
                                checked = summary.checked,
                                rescued = summary.rescued,
                                detect_errors = summary.detect_errors,
                                update_errors = summary.update_errors,
                                list_failed = summary.list_failed,
                                "codex null rescue had errors; marker not written so next startup will retry"
                            );
                            return;
                        }
                        if let Some(parent) = marker.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let _ = std::fs::write(&marker, "");
                    });
                }
            }

            info!(
                "[boot] +{}ms: emitters injected + workspace watcher started",
                boot_t0.elapsed().as_millis()
            );

            // ---- 注册截图全局快捷键（仅 Windows，macOS 截图功能暂未实现）----
            #[cfg(target_os = "windows")]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let settings_svc = app.state::<Arc<SettingsService>>();
                let settings = settings_svc.get_settings();
                let shortcut_str = settings.screenshot.shortcut.clone();
                if !shortcut_str.is_empty() {
                    if let Ok(shortcut) =
                        shortcut_str.parse::<tauri_plugin_global_shortcut::Shortcut>()
                    {
                        let app_handle = app.handle().clone();
                        let settings_service = settings_svc.inner().clone();
                        if let Err(e) =
                            app.global_shortcut()
                                .on_shortcut(shortcut, move |_app, _sc, event| {
                                    if event.state
                                        == tauri_plugin_global_shortcut::ShortcutState::Pressed
                                    {
                                        trigger_screenshot(&app_handle, settings_service.clone());
                                    }
                                })
                        {
                            error!(
                                "[screenshot] Failed to register shortcut '{}': {}",
                                shortcut_str, e
                            );
                        }
                    } else {
                        error!("[screenshot] Invalid shortcut format: {}", shortcut_str);
                    }
                }
            }

            // ---- 启动 Orchestrator HTTP 服务器 ----
            {
                let orch_svc = app.state::<Arc<OrchestratorService>>();
                let term_svc = app.state::<Arc<TerminalService>>();
                let terminal_backend_state = app.state::<Arc<TerminalBackendState>>();
                let session_restore_svc = app.state::<Arc<SessionRestoreService>>();
                let prov_svc = app.state::<Arc<ProviderService>>();
                let launch_profile_svc = app.state::<Arc<LaunchProfileService>>();
                let shared_mcp_svc = app.state::<Arc<SharedMcpService>>();
                let mcp_config_svc = app.state::<Arc<McpConfigService>>();
                let proj_svc = app.state::<Arc<ProjectService>>();
                let ws_svc_orch = app.state::<Arc<WorkspaceService>>();
                let ssh_machine_svc = app.state::<Arc<SshMachineService>>();
                let todo_svc = app.state::<Arc<TodoService>>();
                let memory_svc = app.state::<Arc<MemoryService>>();
                let tb_svc = app.state::<Arc<TaskBindingService>>();
                let spec_svc = app.state::<Arc<SpecService>>();
                let skill_svc = app.state::<Arc<SkillService>>();
                let external_skill_registry = app.state::<Arc<ExternalSkillRegistry>>();
                let lh_svc = app.state::<Arc<LaunchHistoryService>>();
                let history_watch_manager = app.state::<Arc<HistoryWatchManager>>();
                let notif_svc = app.state::<Arc<NotificationService>>();
                let ccchan_svc = app.state::<Arc<CCChanService>>();
                let settings_svc = app.state::<Arc<SettingsService>>();
                let plan_archive_svc = app.state::<Arc<PlanArchiveService>>();
                let runner_svc = app.state::<Arc<cc_panes_core::services::RunnerService>>();
                let dsh_svc = app.state::<Arc<DshService>>();
                let ai_panel_repo_state =
                    app.state::<Arc<cc_panes_core::repository::AiPanelRepository>>();
                let mcp_tool_call_stats_repo_state =
                    app.state::<Arc<cc_panes_core::repository::McpToolCallStatsRepository>>();
                let turn_notify_registry_state = app.state::<Arc<services::TurnNotifyRegistry>>();
                let start_locks = app.state::<Arc<StartLocks>>();
                let paths = app.state::<Arc<AppPaths>>();
                if let Err(e) = orch_svc.start(
                    term_svc.inner().clone(),
                    terminal_backend_state.inner().clone(),
                    app.state::<Arc<MediaService>>().inner().clone(),
                    session_restore_svc.inner().clone(),
                    prov_svc.inner().clone(),
                    launch_profile_svc.inner().clone(),
                    shared_mcp_svc.inner().clone(),
                    mcp_config_svc.inner().clone(),
                    proj_svc.inner().clone(),
                    ws_svc_orch.inner().clone(),
                    ssh_machine_svc.inner().clone(),
                    todo_svc.inner().clone(),
                    memory_svc.inner().clone(),
                    tb_svc.inner().clone(),
                    app.state::<Arc<TaskQueueService>>().inner().clone(),
                    spec_svc.inner().clone(),
                    skill_svc.inner().clone(),
                    external_skill_registry.inner().clone(),
                    lh_svc.inner().clone(),
                    history_watch_manager.inner().clone(),
                    notif_svc.inner().clone(),
                    ccchan_svc.inner().clone(),
                    settings_svc.inner().clone(),
                    plan_archive_svc.inner().clone(),
                    runner_svc.inner().clone(),
                    dsh_svc.inner().clone(),
                    ai_panel_repo_state.inner().clone(),
                    mcp_tool_call_stats_repo_state.inner().clone(),
                    turn_notify_registry_state.inner().clone(),
                    start_locks.inner().clone(),
                    app.handle().clone(),
                    paths.inner().clone(),
                ) {
                    error!("[orchestrator] Failed to start: {}", e);
                }
                // 注入 Orchestrator 连接信息到 TerminalService
                if let Some(port) = orch_svc.port() {
                    term_svc.set_orchestrator_info(port, orch_svc.token().to_string());
                }
                // 阶段 2.8：注入 SessionStateMachine 到 TerminalService（hook 主导时降级 PTY 推断）
                term_svc.set_state_machine(orch_svc.session_state_machine());

                let queue_worker = TaskQueueWorker::start(
                    app.handle().clone(),
                    app.state::<Arc<TaskQueueService>>().inner().clone(),
                    terminal_backend_state.inner().clone(),
                    orch_svc.session_state_machine(),
                    lh_svc.inner().clone(),
                    app.state::<Arc<cc_cli_adapters::CliToolRegistry>>()
                        .inner()
                        .clone(),
                )?;
                app.manage(queue_worker);

                // IM 外推桥：订阅状态机 broadcast，把会话事件推送到钉钉/企微/飞书。
                // 挂 app 进程侧（不进 daemon），不涉及 boundary_events 契约表。
                let im_bridge = Arc::new(services::im_bridge::ImBridgeService::new(
                    app.handle().clone(),
                    settings_svc.inner().clone(),
                    tb_svc.inner().clone(),
                ));
                app.manage(im_bridge.clone());
                services::im_bridge::spawn_im_transition_consumer(
                    im_bridge,
                    turn_notify_registry_state.inner().clone(),
                    orch_svc.session_state_machine().subscribe_transitions(),
                );
            }
            info!(
                "[boot] +{}ms: orchestrator started",
                boot_t0.elapsed().as_millis()
            );

            // ---- 共享 MCP Server 启动 ----
            {
                let svc = app.state::<Arc<SharedMcpService>>().inner().clone();
                let term_svc = app.state::<Arc<TerminalService>>().inner().clone();
                svc.set_on_running_changed(TerminalDaemonControlLink::report_shared_mcp_urls);
                svc.start_all();
                svc.start_health_check();
                TerminalDaemonControlLink::report_shared_mcp_urls(svc.get_running_servers_urls());
                // 注入到 TerminalService
                term_svc.set_shared_mcp_service(svc);
            }
            info!(
                "[boot] +{}ms: shared MCP servers started",
                boot_t0.elapsed().as_millis()
            );

            /* ---- 资源监控定时推送 已禁用（macOS 卡顿排查）----
            {
                let term_svc = app.state::<Arc<TerminalService>>().inner().clone();
                let proc_svc = app.state::<Arc<ProcessMonitorService>>().inner().clone();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::time::{interval, Duration};
                    let mut ticker = interval(Duration::from_secs(3));
                    let refreshing = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    loop {
                        ticker.tick().await;
                        let pids = term_svc.get_active_pids();
                        if pids.is_empty() {
                            continue;
                        }
                        if refreshing.load(std::sync::atomic::Ordering::Relaxed) {
                            warn!("[resource-monitor] previous refresh still running, skipping");
                            continue;
                        }
                        let pid_count = pids.len();
                        let t0 = std::time::Instant::now();
                        proc_svc.update_tracked_pids(pids);
                        let proc_svc_clone = proc_svc.clone();
                        let refreshing_clone = refreshing.clone();
                        let app_handle_clone = app_handle.clone();
                        refreshing.store(true, std::sync::atomic::Ordering::Relaxed);
                        tauri::async_runtime::spawn(async move {
                            let result = tauri::async_runtime::spawn_blocking(move || {
                                proc_svc_clone.refresh_resource_stats()
                            })
                            .await;
                            refreshing_clone
                                .store(false, std::sync::atomic::Ordering::Relaxed);
                            if let Ok(Ok(stats)) = result {
                                let elapsed = t0.elapsed().as_millis();
                                if elapsed > 2000 {
                                    warn!(
                                        "[resource-monitor] slow refresh: {} pids in {}ms",
                                        pid_count, elapsed
                                    );
                                } else {
                                    debug!(
                                        "[resource-monitor] refreshed {} pids in {}ms",
                                        pid_count, elapsed
                                    );
                                }
                                let _ = app_handle_clone.emit("resource-stats", &stats);
                            }
                        });
                    }
                });
            }
            */

            info!("[boot] resource monitor DISABLED (macOS perf test)");

            // ---- Usage stats background jobs ----
            // 必须在 tokio runtime 内调（内部用 tokio::spawn），否则 panic "no reactor running"
            {
                let svc = app.state::<Arc<UsageStatsService>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    svc.start_background_tasks();
                });
            }
            {
                let svc = app.state::<Arc<SessionIndexService>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    svc.start_background_tasks();
                });
            }

            // ---- Media generation worker ----
            // Media runs share the same durable SQLite state as the Canvas.
            // Keep the worker in the Tauri runtime so queued jobs continue
            // after the frontend is refreshed or temporarily hidden.
            {
                let media_service = app.state::<Arc<MediaService>>().inner().clone();
                let provider_service = app.state::<Arc<ProviderService>>().inner().clone();
                let comfy_runtime = app.state::<Arc<ComfyRuntimeService>>().inner().clone();
                // Media generation is cloud-first. Keep the local ComfyUI
                // runtime available for explicit API/command use, but do not
                // spawn a Python/GPU process during normal app startup.
                let comfy_status = comfy_runtime.status();
                let (registry, skipped) = registry_from_providers(provider_service.list_providers());
                for diagnostic in skipped {
                    warn!(diagnostic, "[media] provider was not registered");
                }
                let initial_comfy_adapter = if comfy_status.running && comfy_status.ready {
                    match comfy_runtime
                        .adapter_profile()
                        .and_then(ComfyMediaAdapter::new)
                    {
                        Ok(adapter) => {
                            let adapter = Arc::new(adapter);
                            if let Err(error) = registry.upsert(adapter.clone()) {
                                warn!(error = %error, "[media] local ComfyUI provider was not registered");
                                None
                            } else {
                                Some(adapter)
                            }
                        }
                        Err(error) => {
                            warn!(error = %error, "[media] local ComfyUI adapter setup failed");
                            None
                        }
                    }
                } else {
                    None
                };
                let runtime_registry = registry.clone();
                let media_event_service = media_service.clone();
                let worker = Arc::new(
                    MediaJobWorker::new(
                        media_service,
                        registry.clone(),
                        format!("desktop-{}", std::process::id()),
                    )
                        .with_provider_service(provider_service.clone()),
                );
                if let Some(adapter) = initial_comfy_adapter.as_ref() {
                    worker.track_comfy_adapter(COMFY_LOCAL_PROVIDER_ID, adapter.clone());
                }
                app.manage(worker.clone());
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut poll_ticker = tokio::time::interval(std::time::Duration::from_secs(2));
                    let mut event_ticker = tokio::time::interval(std::time::Duration::from_millis(100));
                    let mut registered_comfy_port = if comfy_status.running && comfy_status.ready {
                        comfy_status.port
                    } else {
                        0
                    };
                    let mut comfy_streams = std::collections::HashMap::new();
                    let mut next_event_connect = std::collections::HashMap::new();
                    loop {
                        tokio::select! {
                            _ = event_ticker.tick() => {
                                for (provider_id, adapter) in worker.comfy_adapters() {
                                    let now = tokio::time::Instant::now();
                                    let can_connect = next_event_connect
                                        .get(&provider_id)
                                        .is_none_or(|deadline| *deadline <= now);
                                    if !comfy_streams.contains_key(&provider_id) && can_connect {
                                        match tokio::time::timeout(
                                            std::time::Duration::from_millis(500),
                                            adapter.connect_events(),
                                        )
                                        .await
                                        {
                                            Ok(Ok(stream)) => {
                                                comfy_streams.insert(provider_id.clone(), stream);
                                                next_event_connect.remove(&provider_id);
                                            }
                                            Ok(Err(error)) => {
                                                warn!(provider_id, error = %error, "[media] ComfyUI websocket unavailable; history polling remains active");
                                                next_event_connect.insert(
                                                    provider_id.clone(),
                                                    now + std::time::Duration::from_secs(2),
                                                );
                                            }
                                            Err(_) => {
                                                next_event_connect.insert(
                                                    provider_id.clone(),
                                                    now + std::time::Duration::from_secs(2),
                                                );
                                            }
                                        }
                                    }
                                    let Some(stream) = comfy_streams.get_mut(&provider_id) else {
                                        continue;
                                    };
                                    let result = tokio::time::timeout(
                                        std::time::Duration::from_millis(20),
                                        stream.next_event(),
                                    )
                                    .await;
                                    match result {
                                        Ok(Ok(Some(event))) => {
                                            match worker.apply_comfy_event(&provider_id, &event) {
                                                Ok(Some(run)) => {
                                                    let workspace_id = media_event_service
                                                        .get_node(&run.node_id)
                                                        .ok()
                                                        .flatten()
                                                        .map(|node| node.workspace_id);
                                                    let _ = app_handle.emit(
                                                        "media-job-changed",
                                                        serde_json::json!({
                                                            "type": "media-job-changed",
                                                            "workspaceId": workspace_id,
                                                            "runId": run.id,
                                                            "nodeId": run.node_id,
                                                            "status": run.status,
                                                            "progress": run.progress,
                                                            "assetIds": run.output_asset_ids,
                                                            "errorCode": run.error_code,
                                                            "errorMessage": run.error_message,
                                                        }),
                                                    );
                                                }
                                                Ok(None) => {}
                                                Err(error) => warn!(provider_id, error = %error, "[media] failed to apply ComfyUI event"),
                                            }
                                        }
                                        Ok(Ok(None)) | Ok(Err(_)) => {
                                            comfy_streams.remove(&provider_id);
                                            next_event_connect.insert(
                                                provider_id.clone(),
                                                now + std::time::Duration::from_secs(1),
                                            );
                                        }
                                        Err(_) => {}
                                    }
                                }
                            }
                            _ = poll_ticker.tick() => {
                                // The runtime can be started or restarted from the
                                // media UI. Refresh the adapter so queued work never
                                // targets a stale ephemeral port.
                                let runtime_status = comfy_runtime.status();
                                if runtime_status.running
                                    && runtime_status.ready
                                    && (runtime_status.port != registered_comfy_port
                                        || runtime_registry.get(COMFY_LOCAL_PROVIDER_ID).is_none())
                                {
                                    match comfy_runtime
                                        .adapter_profile()
                                        .and_then(ComfyMediaAdapter::new)
                                    {
                                        Ok(adapter) => {
                                            let adapter = Arc::new(adapter);
                                            if let Err(error) = runtime_registry.upsert(adapter.clone()) {
                                                warn!(error = %error, "[media] failed to refresh local ComfyUI adapter");
                                            } else {
                                                registered_comfy_port = runtime_status.port;
                                                worker.track_comfy_adapter(
                                                    COMFY_LOCAL_PROVIDER_ID,
                                                    adapter,
                                                );
                                                comfy_streams.remove(COMFY_LOCAL_PROVIDER_ID);
                                                next_event_connect.remove(COMFY_LOCAL_PROVIDER_ID);
                                            }
                                        }
                                        Err(error) => {
                                            warn!(error = %error, "[media] failed to create local ComfyUI adapter");
                                        }
                                    }
                                } else if (!runtime_status.running || !runtime_status.ready)
                                    && registered_comfy_port != 0
                                {
                                    runtime_registry.remove(COMFY_LOCAL_PROVIDER_ID);
                                    worker.forget_comfy_adapter(COMFY_LOCAL_PROVIDER_ID);
                                    registered_comfy_port = 0;
                                    comfy_streams.remove(COMFY_LOCAL_PROVIDER_ID);
                                    next_event_connect.remove(COMFY_LOCAL_PROVIDER_ID);
                                }
                                match worker.run_batch().await {
                                    Ok(runs) => {
                                        for run in runs {
                                        let workspace_id = media_event_service
                                            .get_node(&run.node_id)
                                            .ok()
                                            .flatten()
                                            .map(|node| node.workspace_id);
                                        let _ = app_handle.emit(
                                            "media-job-changed",
                                            serde_json::json!({
                                                "type": "media-job-changed",
                                                "workspaceId": workspace_id,
                                                "runId": run.id,
                                                "nodeId": run.node_id,
                                                "status": run.status,
                                                "progress": run.progress,
                                                "assetIds": run.output_asset_ids,
                                                "errorCode": run.error_code,
                                                "errorMessage": run.error_message,
                                            }),
                                        );
                                        }
                                    }
                                    Err(error) => warn!(error = %error, "[media] worker iteration failed"),
                                }
                            }
                        }
                    }
                });
            }
            info!(
                "[boot] +{}ms: usage stats, session index, and media background jobs started",
                boot_t0.elapsed().as_millis()
            );

            // ---- 系统托盘 ----
            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

            let tooltip = if cfg!(debug_assertions) {
                "CC-Panes [DEV]"
            } else {
                "CC-Panes"
            };
            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .tooltip(tooltip)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        // 截图期间不恢复窗口，避免窗口重新出现在截图中
                        if CAPTURING.load(Ordering::SeqCst) {
                            return;
                        }
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击托盘图标 → 显示窗口
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        // 截图期间不恢复窗口
                        if CAPTURING.load(Ordering::SeqCst) {
                            return;
                        }
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ---- macOS: 运行时设置 titlebar overlay 样式 ----
            // config 保持 decorations: false（Windows 兼容），macOS 在此通过 NSWindow API
            // 设置透明标题栏 + fullSizeContentView，等效于 titleBarStyle: Overlay
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| unsafe {
                        use objc2_app_kit::{
                            NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
                            NSWindowTitleVisibility,
                        };

                        let ns_window: &NSWindow = &*webview.ns_window().cast();

                        // 1. 添加 decorations（标题栏 + 红绿灯按钮）
                        let mut mask = ns_window.styleMask();
                        mask.insert(NSWindowStyleMask::Titled);
                        mask.insert(NSWindowStyleMask::Closable);
                        mask.insert(NSWindowStyleMask::Miniaturizable);
                        mask.insert(NSWindowStyleMask::Resizable);
                        mask.insert(NSWindowStyleMask::FullSizeContentView);
                        ns_window.setStyleMask(mask);

                        // 2. 允许绿色按钮和系统 Window 菜单进入原生 macOS 全屏
                        let mut behavior = ns_window.collectionBehavior();
                        behavior.insert(NSWindowCollectionBehavior::FullScreenPrimary);
                        ns_window.setCollectionBehavior(behavior);

                        // 3. 标题栏透明 + 隐藏标题文字
                        ns_window.setTitlebarAppearsTransparent(true);
                        ns_window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
                    });
                    info!("[boot] macOS: configured titlebar overlay via NSWindow API");

                    install_macos_paste_key_monitor(app.handle().clone());

                    force_webview_focus(&window);
                    info!("[boot] macOS: forced WKWebView as firstResponder");
                }
            }

            restore_main_window_geometry(app.handle());

            info!(
                "[boot] +{}ms: === setup complete ===",
                boot_t0.elapsed().as_millis()
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        if should_close_main_window_to_tray(window) {
                            // 主窗口关闭 → 隐藏到托盘（不退出）
                            match window.hide() {
                                Ok(()) => api.prevent_close(),
                                Err(e) => {
                                    error!("failed to hide main window to tray: {e}");
                                    api.prevent_close();
                                    window.app_handle().exit(0);
                                }
                            }
                        } else {
                            api.prevent_close();
                            window.app_handle().exit(0);
                        }
                    } else if window.label().starts_with("popup-") {
                        // 弹出窗口关闭 → 通知主窗口回收标签（不阻止关闭）
                        let label = window.label().to_string();
                        let _ = window.app_handle().emit("popup-window-closing", &label);
                    }
                }
                #[cfg(target_os = "macos")]
                WindowEvent::Focused(true) if window.label() == "main" => {
                    if let Some(ww) = window.app_handle().get_webview_window("main") {
                        force_webview_focus(&ww);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 项目命令
            list_projects,
            add_project,
            remove_project,
            get_project,
            update_project_name,
            update_project_alias,
            // 终端命令
            cancel_terminal_launch,
            create_terminal_session,
            start_pi_rpc_session,
            start_acp_chat,
            list_automations,
            save_automation,
            delete_automation,
            run_automation_now,
            list_automation_runs,
            list_acp_engines,
            list_acp_chat_history,
            rename_acp_chat_history,
            delete_acp_chat_history,
            compute_text_diff,
            read_acp_image_attachment,
            prompt_acp_chat,
            cancel_acp_chat,
            respond_acp_permission,
            set_acp_chat_mode,
            set_acp_chat_model,
            get_acp_chat,
            stop_acp_chat,
            list_pi_rpc_sessions,
            get_pi_rpc_session,
            prompt_pi_rpc_session,
            abort_pi_rpc_session,
            get_pi_rpc_state,
            stop_pi_rpc_session,
            adopt_terminal_session,
            release_terminal_session,
            write_terminal,
            resize_terminal,
            kill_terminal,
            kill_terminal_idempotent,
            submit_to_session,
            get_all_terminal_status,
            get_bridge_stats,
            get_available_shells,
            get_windows_build_number,
            check_environment,
            list_cli_tools,
            get_terminal_daemon_client_info,
            get_terminal_adoption_snapshot,
            get_terminal_output,
            get_terminal_recent_output,
            get_terminal_replay_snapshot,
            resolve_terminal_path_link,
            run_terminal_path_link_action,
            set_hidden_terminal_sessions,
            ack_terminal_output,
            get_terminal_recovery_snapshot,
            upload_terminal_checkpoint,
            record_terminal_input,
            query_context_usage,
            query_usage_stats,
            refresh_usage_stats,
            list_session_index,
            refresh_session_index,
            check_codex_rollout_exists,
            read_agent_transcript_cmd,
            get_terminal_task_queue,
            stage_terminal_task_queue_clipboard_image,
            add_terminal_task_queue_item,
            delete_terminal_task_queue_item,
            clear_terminal_task_queue,
            update_terminal_task_queue,
            retry_terminal_task_queue_item,
            // 窗口命令
            browser_create,
            browser_set_bounds,
            browser_set_visible,
            browser_navigate,
            browser_back,
            browser_forward,
            browser_reload,
            browser_open_devtools,
            browser_close,
            open_browser_tab,
            close_window,
            minimize_window,
            maximize_window,
            toggle_always_on_top,
            set_decorations,
            enter_fullscreen,
            exit_fullscreen,
            is_fullscreen,
            enter_mini_mode,
            exit_mini_mode,
            get_app_cwd,
            create_popup_terminal_window,
            get_popup_tab_data,
            open_layout_switcher_window,
            close_layout_switcher_window,
            get_layout_switcher_snapshot,
            get_layout_switcher_state,
            save_layout_switcher_snapshot,
            save_layout_switcher_state,
            show_ccchan,
            hide_ccchan,
            resize_ccchan_for_bubble,
            resize_ccchan_for_chat,
            resize_ccchan_for_menu,
            move_ccchan_window,
            start_ccchan_chat,
            send_to_ccchan,
            stop_ccchan_chat,
            is_ccchan_chat_session_alive,
            get_ccchan_pets,
            get_ccchan_settings,
            save_ccchan_settings,
            get_ccchan_pets_dir,
            open_ccchan_pets_dir,
            // Git 命令
            get_git_branch,
            get_git_changed_files,
            get_git_diff,
            get_git_repo_info,
            get_git_status,
            get_git_file_statuses,
            get_git_local_branches,
            get_git_log,
            list_git_commit_files,
            git_clone,
            git_pull,
            git_push,
            git_fetch,
            git_stash,
            git_stash_pop,
            // Claude 会话命令
            list_claude_sessions,
            list_all_claude_sessions,
            list_codex_sessions,
            list_opencode_sessions,
            scan_broken_sessions,
            clean_session_file,
            clean_all_broken_sessions,
            extract_last_prompt,
            // 历史命令
            add_launch_history,
            list_launch_history,
            clear_launch_history,
            delete_launch_history,
            read_session_state,
            update_launch_session_id,
            update_launch_resume_source,
            update_launch_last_prompt,
            touch_launch_by_session,
            detect_claude_session,
            detect_resume_session,
            detect_tailscale_status,
            start_launch_history_backfill,
            debug_encode_path,
            // Local History 命令
            init_project_history,
            list_file_versions,
            get_version_content,
            restore_file_version,
            get_history_config,
            get_history_watch_stats,
            update_history_config,
            stop_project_history,
            cleanup_project_history,
            // Local History - Diff
            get_version_diff,
            get_versions_diff,
            // Local History - 标签
            put_label,
            list_labels,
            delete_label,
            restore_to_label,
            create_auto_label,
            // Local History - 目录级历史 + 最近更改
            list_directory_changes,
            get_recent_changes,
            // Local History - 删除文件 + 压缩
            list_deleted_files,
            compress_history,
            // Local History - 分支感知 + Worktree
            get_current_branch,
            get_file_branches,
            list_file_versions_by_branch,
            list_worktree_recent_changes,
            // Hooks 命令
            get_project_cli_hooks,
            set_project_cli_hook_enabled,
            get_workflow,
            save_workflow,
            init_ccpanes,
            // Journal 命令
            add_journal_session,
            get_journal_index,
            get_recent_journal,
            // Worktree 命令
            is_git_repo,
            list_worktrees,
            add_worktree,
            remove_worktree,
            // Workspace 命令
            list_workspaces,
            create_workspace,
            get_workspace,
            rename_workspace,
            delete_workspace,
            add_workspace_project,
            add_ssh_project,
            remove_workspace_project,
            check_workspace_project_paths,
            update_workspace_alias,
            update_workspace_project_alias,
            update_workspace_provider,
            update_workspace_path,
            set_workspace_archived,
            set_workspace_project_archived,
            update_workspace,
            reorder_workspaces,
            scan_workspace_directory,
            preview_workspace_migration,
            execute_workspace_migration,
            rollback_workspace_migration,
            preview_project_migration,
            execute_project_migration,
            rollback_project_migration,
            // Settings 命令
            get_settings,
            cleanup_before_uninstall,
            update_settings,
            test_proxy,
            test_cli_launcher,
            transcribe_voice_input,
            get_data_dir_info,
            migrate_data_dir,
            generate_claude_md,
            get_log_dir,
            trigger_notification,
            // IM 外推命令
            test_im_channel,
            get_im_bridge_status,
            // Provider 命令
            list_launch_profiles,
            get_launch_profile,
            create_launch_profile,
            update_launch_profile,
            delete_launch_profile,
            set_default_launch_profile,
            preview_launch_profile_resolution,
            list_quick_commands,
            create_quick_command,
            update_quick_command,
            delete_quick_command,
            list_project_quick_commands,
            save_project_quick_commands,
            list_providers,
            get_provider,
            get_default_provider,
            add_provider,
            update_provider,
            remove_provider,
            set_default_provider,
            detect_system_provider,
            read_config_dir_info,
            open_path_in_explorer,
            get_display_server,
            // Todo 命令
            create_todo,
            get_todo,
            update_todo,
            delete_todo,
            query_todos,
            reorder_todos,
            batch_update_todo_status,
            get_todo_stats,
            toggle_todo_my_day,
            check_todo_reminders,
            list_todo_activities,
            add_todo_subtask,
            update_todo_subtask,
            delete_todo_subtask,
            toggle_todo_subtask,
            reorder_todo_subtasks,
            // Spec 命令
            create_spec,
            list_specs,
            get_spec_content,
            save_spec_content,
            update_spec,
            delete_spec,
            sync_spec_tasks,
            handle_terminal_exit_spec,
            handle_terminal_exit_spec_by_session,
            // MCP 配置命令
            list_mcp_servers,
            get_mcp_server,
            upsert_mcp_server,
            remove_mcp_server,
            // Skill 命令
            list_skills,
            list_external_skills,
            get_skill,
            save_skill,
            delete_skill,
            copy_skill,
            list_skill_market_entries,
            search_skill_market,
            describe_skill_market_entry,
            install_skill_market_entry,
            list_skill_market_categories,
            list_user_skills,
            install_market_skill,
            remove_user_skill,
            list_bundled_skills,
            parse_import_url,
            execute_import,
            take_pending_import,
            // Plan 命令
            list_plans,
            get_plan_content,
            delete_plan,
            // FileSystem 命令
            fs_list_directory,
            fs_read_file,
            fs_write_file,
            fs_create_file,
            fs_create_directory,
            fs_delete_entry,
            fs_rename_entry,
            fs_copy_entry,
            fs_move_entry,
            fs_get_entry_info,
            search_project_files,
            search_project_contents,
            // Screenshot 命令
            screenshot_save_clipboard_image,
            screenshot_update_shortcut,
            // Clipboard 命令
            read_clipboard_file_paths,
            set_macos_terminal_focused,
            // Orchestrator 命令
            get_orchestrator_port,
            get_orchestrator_status,
            get_orchestrator_token,
            respond_orchestrator_query,
            list_ai_panels,
            record_ai_panel_event,
            list_ai_panel_history,
            get_ai_panel_content,
            delete_ai_panel,
            // TaskBinding 命令
            create_task_binding,
            get_task_binding,
            find_task_binding_by_session,
            update_task_binding,
            update_task_binding_patch,
            delete_task_binding,
            delete_task_binding_cascade,
            query_task_bindings,
            register_plan_leader,
            register_plan_worker,
            register_plan_child,
            get_plan_collaboration,
            reconcile_plan_collaboration,
            // Memory 命令
            search_memory,
            store_memory,
            list_memories,
            get_memory,
            update_memory,
            delete_memory,
            get_memory_stats,
            prepare_session_context,
            format_memory_for_injection,
            // SSH Machine 命令
            list_ssh_machines,
            get_ssh_machine,
            add_ssh_machine,
            update_ssh_machine,
            remove_ssh_machine,
            check_ssh_connectivity,
            ssh_fs_list_directory,
            ssh_fs_configure_password,
            ssh_fs_read_file,
            ssh_fs_read_image,
            ssh_fs_write_file,
            ssh_fs_create_file,
            ssh_fs_create_directory,
            ssh_fs_rename_entry,
            ssh_fs_delete_entry,
            ssh_fs_upload_file,
            ssh_fs_download_file,
            ssh_fs_set_permissions,
            // WSL 发现命令
            discover_wsl_distros,
            // Process Monitor 命令
            scan_claude_processes,
            kill_claude_process,
            kill_claude_processes,
            get_resource_stats,
            get_system_stats,
            get_resource_tree,
            kill_orphan_processes,
            // Runner Registry 命令
            runner_list_profiles,
            runner_get_profile,
            runner_upsert_profile,
            runner_delete_profile,
            runner_plan_launch,
            runner_list_active_instances,
            runner_list_port_conflicts,
            runner_refresh_port_claims,
            runner_register_for_session,
            runner_mark_instance_exited,
            runner_kill_instance,
            runner_kill_pid,
            runner_register_implicit_instance,
            // 共享 MCP 命令
            get_shared_mcp_config,
            get_shared_mcp_status,
            upsert_shared_mcp_server,
            remove_shared_mcp_server,
            start_shared_mcp_server,
            stop_shared_mcp_server,
            restart_shared_mcp_server,
            update_shared_mcp_global_config,
            import_shared_mcp_from_claude,
            // DeepSeek Harness（dsh）实例命令
            start_dsh_instance,
            stop_dsh_instance,
            list_dsh_instances,
            get_dsh_instance,
            // Web access 命令
            get_web_access_status,
            start_web_access,
            stop_web_access,
            restart_web_access,
            open_web_access,
            set_web_access_password,
            stop_terminal_daemon,
            // Session Restore 命令
            save_terminal_sessions,
            load_terminal_sessions,
            clear_terminal_sessions,
            prune_terminal_sessions,
            save_layout_snapshot,
            load_layout_snapshot,
            clear_layout_snapshot,
            load_session_output,
            clear_session_output,
            prune_stale_session_outputs,
            list_workspace_snapshots,
            get_workspace_snapshot,
            delete_workspace_snapshot,
            // Media canvas commands
            get_comfy_runtime_status,
            get_comfy_system_stats,
            start_comfy_runtime,
            stop_comfy_runtime,
             restart_comfy_runtime,
             free_comfy_memory,
             get_comfy_object_info,
             get_media_provider_capabilities,
             create_media_node,
            get_media_node,
            list_media_nodes,
            update_media_node,
            delete_media_node,
            create_media_run,
            get_media_run,
            resolve_media_asset,
             list_media_runs,
             list_recoverable_media_runs,
             get_media_queue_snapshot,
             get_media_scheduler_snapshot,
             cancel_media_run,
             retry_media_run,
             replay_media_run,
             set_media_run_priority,
             transition_media_run,
            create_media_asset,
            stage_media_input,
            get_media_asset,
            list_media_assets,
            create_media_edge,
            get_media_edge,
            list_media_edges,
            delete_media_edge,
            // Wallpaper 命令
            import_wallpaper,
            list_wallpapers,
            remove_wallpaper,
            resolve_wallpaper_asset
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            // 注：macOS 的 RunEvent::Opened 已由 tauri-plugin-deep-link 转成 on_open_url（见 setup），
            // 这里不再手动处理，避免重复分发同一个导入链接。
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if webview_reliability::webview_recovery_holds_exit() {
                    info!("[webview-recovery] holding app open while main window rebuilds");
                    api.prevent_exit();
                }
            }
            if let tauri::RunEvent::Exit = event {
                info!("[cleanup] Application exiting, cleaning up resources...");

                app_handle.state::<Arc<TaskQueueWorker>>().stop();

                // 在 cleanup_all() 前保存终端输出到文件
                let outputs = terminal_cleanup.get_all_session_outputs();
                if !outputs.is_empty() {
                    info!(
                        "[cleanup] Saving {} session outputs for restore",
                        outputs.len()
                    );
                    for (session_id, lines) in &outputs {
                        if let Err(e) =
                            session_restore_cleanup.save_session_output(session_id, lines)
                        {
                            error!("[cleanup] Failed to save output for {}: {}", session_id, e);
                        }
                    }
                }

                shared_mcp_cleanup.stop_health_check();
                shared_mcp_cleanup.stop_all();
                orchestrator_cleanup.shutdown();
                if let Err(e) = usage_stats_cleanup.flush_pending() {
                    error!("[cleanup] Failed to flush usage stats: {}", e);
                }
                tauri::async_runtime::block_on(pi_rpc_cleanup.cleanup_all());
                tauri::async_runtime::block_on(acp_chat_cleanup.cleanup_all());
                terminal_cleanup.cleanup_all();
                history_cleanup.stop_all_watching();
                workspace_cleanup.stop_watcher();
                web_access_cleanup.stop();
            }
        });
}
