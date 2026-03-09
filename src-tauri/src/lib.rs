mod commands;
pub mod models;
pub mod pty;
pub mod repository;
pub mod services;
pub mod utils;

use commands::{
    add_launch_history, add_project, clear_launch_history, delete_launch_history,
    read_session_state, update_launch_session_id, update_launch_last_prompt, touch_launch_by_session,
    detect_claude_session, debug_encode_path,
    create_terminal_session,
    enter_fullscreen, exit_fullscreen, get_all_terminal_status, get_available_shells, get_windows_build_number,
    get_git_branch, get_git_status, get_git_file_statuses, get_project,
    git_clone, git_fetch, git_pull, git_push, git_stash, git_stash_pop, is_fullscreen, kill_terminal,
    list_all_claude_sessions, list_claude_sessions, scan_broken_sessions,
    clean_session_file, clean_all_broken_sessions, extract_last_prompt,
    list_launch_history, list_projects,
    remove_project, resize_terminal, set_decorations, toggle_always_on_top, enter_mini_mode, exit_mini_mode,
    close_window, minimize_window, maximize_window, get_app_cwd,
    update_project_alias, update_project_name, write_terminal,
    // Local History 命令
    init_project_history, list_file_versions, get_version_content,
    restore_file_version, get_history_config, update_history_config,
    stop_project_history, cleanup_project_history,
    // Local History - Diff
    get_version_diff, get_versions_diff,
    // Local History - 标签
    put_label, list_labels, delete_label, restore_to_label, create_auto_label,
    // Local History - 目录级历史 + 最近更改
    list_directory_changes, get_recent_changes,
    // Local History - 删除文件 + 压缩
    list_deleted_files, compress_history,
    // Local History - 分支感知 + Worktree
    get_current_branch, get_file_branches, list_file_versions_by_branch,
    list_worktree_recent_changes,
    // Hooks 命令
    is_hooks_enabled, enable_hooks, disable_hooks,
    get_hooks_status, enable_hook, disable_hook, enable_all_hooks,
    get_workflow, save_workflow, init_ccpanes,
    // Journal 命令
    add_journal_session, get_journal_index, get_recent_journal,
    // Worktree 命令
    is_git_repo, list_worktrees, add_worktree, remove_worktree,
    // Workspace 命令
    list_workspaces, create_workspace, get_workspace, rename_workspace,
    delete_workspace, add_workspace_project, remove_workspace_project,
    update_workspace_alias, update_workspace_project_alias,
    update_workspace_provider, update_workspace_path, update_workspace, reorder_workspaces,
    scan_workspace_directory,
    // Settings 命令
    get_settings, update_settings, test_proxy,
    get_data_dir_info, migrate_data_dir, generate_claude_md,
    // Provider 命令
    list_providers, get_provider, get_default_provider,
    add_provider, update_provider, remove_provider, set_default_provider,
    read_config_dir_info, open_path_in_explorer,
    // Todo 命令
    create_todo, get_todo, update_todo, delete_todo, query_todos,
    reorder_todos, batch_update_todo_status, get_todo_stats,
    toggle_todo_my_day, check_todo_reminders,
    add_todo_subtask, update_todo_subtask, delete_todo_subtask,
    toggle_todo_subtask, reorder_todo_subtasks,
    // MCP 配置命令
    list_mcp_servers, get_mcp_server, upsert_mcp_server, remove_mcp_server,
    // Skill 命令
    list_skills, get_skill, save_skill, delete_skill, copy_skill,
    // Plan 命令
    list_plans, get_plan_content, delete_plan,
    // FileSystem 命令
    fs_list_directory, fs_read_file, fs_write_file, fs_create_file,
    fs_create_directory, fs_delete_entry, fs_rename_entry, fs_copy_entry,
    fs_move_entry, fs_search_files, fs_get_entry_info,
    // Screenshot 命令
    screenshot_capture, screenshot_crop_and_save, screenshot_update_shortcut,
};
use repository::{Database, ProjectRepository, HistoryRepository, TodoRepository};
use services::{ProjectService, TerminalService, HistoryService, HooksService, JournalService, WorktreeService, WorkspaceService, SettingsService, ProviderService, NotificationService, LaunchHistoryService, TodoService, McpConfigService, SkillService, PlanService, FileSystemService, FileSearchIndex, ScreenshotService};
use utils::AppPaths;
use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// 触发截图流程：隐藏主窗口 → 创建全屏截图窗口 → 前端 JS mount 后 invoke 截图
pub fn trigger_screenshot(app: &tauri::AppHandle) {
    use tauri::PhysicalPosition;

    // 防重入：如果截图窗口已存在，不重复触发
    if app.get_webview_window("screenshot").is_some() {
        return;
    }

    // 隐藏主窗口
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.hide();
    }

    // 快速查询显示器信息（<1ms，不截图）
    let monitor_info = match ScreenshotService::get_monitor_info() {
        Ok(info) => info,
        Err(e) => {
            eprintln!("[screenshot] get_monitor_info failed: {}", e);
            if let Some(main_win) = app.get_webview_window("main") {
                let _ = main_win.show();
                let _ = main_win.set_focus();
            }
            return;
        }
    };

    // 创建截图窗口（WebView 初始化 ~500ms，自然替代 sleep 30ms）
    // 前端 JS mount 后再 invoke screenshot_capture 发起截图
    let screenshot_win = tauri::WebviewWindowBuilder::new(
        app,
        "screenshot",
        tauri::WebviewUrl::App("screenshot.html".into()),
    )
    .title("Screenshot")
    .fullscreen(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(true)
    .visible(false)
    .inner_size(monitor_info.width as f64, monitor_info.height as f64)
    .build();

    match screenshot_win {
        Ok(win) => {
            // 定位到目标显示器
            let _ = win.set_position(PhysicalPosition::new(monitor_info.x, monitor_info.y));
            // OS 级全屏，保证覆盖任务栏
            let _ = win.set_fullscreen(true);
            // 前端加载完截图后调用 window.show()
        }
        Err(e) => {
            eprintln!("[screenshot] failed to create window: {}", e);
            if let Some(main_win) = app.get_webview_window("main") {
                let _ = main_win.show();
                let _ = main_win.set_focus();
            }
        }
    }
}

// ============ 应用入口 ============

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 1. 先加载设置，取得 data_dir
    let settings_service = Arc::new(SettingsService::new());
    let data_dir = settings_service.get_settings().general.data_dir;

    // 2. 构造路径管理器
    let app_paths = Arc::new(AppPaths::new(data_dir));

    // 3. 各服务用 app_paths 初始化
    let db = match Database::new(app_paths.database_path()) {
        Ok(db) => Arc::new(db),
        Err(e) => {
            eprintln!("Database initialization failed: {}, trying in-memory fallback", e);
            Arc::new(Database::new_fallback().unwrap_or_else(|e2| {
                panic!("Database initialization completely failed (including fallback): {}", e2);
            }))
        }
    };
    let project_repo = Arc::new(ProjectRepository::new(db.clone()));
    let history_repo = Arc::new(HistoryRepository::new(db.clone()));
    let todo_repo = Arc::new(TodoRepository::new(db));
    let launch_history_service = Arc::new(LaunchHistoryService::new(history_repo));
    let todo_service = Arc::new(TodoService::new(todo_repo));
    let project_service = Arc::new(ProjectService::new(project_repo));
    let history_service = Arc::new(HistoryService::new());
    let hooks_service = Arc::new(HooksService::new());
    let journal_service = Arc::new(JournalService::new(app_paths.workspaces_dir()));
    let worktree_service = Arc::new(WorktreeService::new());
    let workspace_service = Arc::new(WorkspaceService::new(app_paths.workspaces_dir()));
    let provider_service = Arc::new(ProviderService::new(app_paths.providers_path()));
    let notification_service = Arc::new(NotificationService::new());
    let mcp_config_service = Arc::new(McpConfigService::new());
    let skill_service = Arc::new(SkillService::new());
    let plan_service = Arc::new(PlanService::new());
    let search_index = Arc::new(FileSearchIndex::new());
    let filesystem_service = Arc::new(FileSystemService::new(search_index.clone()));
    let terminal_service = Arc::new(TerminalService::new(
        settings_service.clone(),
        provider_service.clone(),
        notification_service.clone(),
        app_paths.clone(),
    ));

    // 保存引用用于退出时清理
    let terminal_cleanup = terminal_service.clone();
    let history_cleanup = history_service.clone();
    let workspace_cleanup = workspace_service.clone();
    let search_index_cleanup = search_index.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_paths)
        .manage(project_service)
        .manage(terminal_service)
        .manage(launch_history_service)
        .manage(history_service)
        .manage(hooks_service)
        .manage(journal_service)
        .manage(worktree_service)
        .manage(workspace_service)
        .manage(settings_service)
        .manage(provider_service)
        .manage(notification_service)
        .manage(todo_service)
        .manage(mcp_config_service)
        .manage(skill_service)
        .manage(plan_service)
        .manage(filesystem_service)
        .setup(|app| {
            // ---- 启动 workspace 目录监控 ----
            let ws_svc = app.state::<Arc<WorkspaceService>>();
            ws_svc.start_watcher(app.handle().clone());

            // ---- 注册截图全局快捷键 ----
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let settings_svc = app.state::<Arc<SettingsService>>();
                let settings = settings_svc.get_settings();
                let shortcut_str = settings.screenshot.shortcut.clone();
                if !shortcut_str.is_empty() {
                    if let Ok(shortcut) = shortcut_str.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                        let app_handle = app.handle().clone();
                        if let Err(e) = app.global_shortcut().on_shortcut(shortcut, move |_app, _sc, event| {
                            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                                trigger_screenshot(&app_handle);
                            }
                        }) {
                            eprintln!("[screenshot] Failed to register shortcut '{}': {}", shortcut_str, e);
                        }
                    } else {
                        eprintln!("[screenshot] Invalid shortcut format: {}", shortcut_str);
                    }
                }
            }

            // ---- 系统托盘 ----
            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let icon =
                tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .tooltip("CC-Panes")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
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
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "screenshot" {
                        // 截图窗口关闭 → 恢复主窗口
                        if let Some(main_win) = window.app_handle().get_webview_window("main") {
                            let _ = main_win.show();
                            let _ = main_win.set_focus();
                        }
                    } else {
                        // 主窗口关闭 → 隐藏到托盘（不退出）
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
                WindowEvent::Destroyed => {
                    if window.label() == "screenshot" {
                        // 截图窗口销毁 → 确保恢复主窗口
                        if let Some(main_win) = window.app_handle().get_webview_window("main") {
                            let _ = main_win.show();
                            let _ = main_win.set_focus();
                        }
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
            create_terminal_session,
            write_terminal,
            resize_terminal,
            kill_terminal,
            get_all_terminal_status,
            get_available_shells,
            get_windows_build_number,
            // 窗口命令
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
            // Git 命令
            get_git_branch,
            get_git_status,
            get_git_file_statuses,
            git_clone,
            git_pull,
            git_push,
            git_fetch,
            git_stash,
            git_stash_pop,
            // Claude 会话命令
            list_claude_sessions,
            list_all_claude_sessions,
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
            update_launch_last_prompt,
            touch_launch_by_session,
            detect_claude_session,
            debug_encode_path,
            // Local History 命令
            init_project_history,
            list_file_versions,
            get_version_content,
            restore_file_version,
            get_history_config,
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
            is_hooks_enabled,
            enable_hooks,
            disable_hooks,
            get_hooks_status,
            enable_hook,
            disable_hook,
            enable_all_hooks,
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
            remove_workspace_project,
            update_workspace_alias,
            update_workspace_project_alias,
            update_workspace_provider,
            update_workspace_path,
            update_workspace,
            reorder_workspaces,
            scan_workspace_directory,
            // Settings 命令
            get_settings,
            update_settings,
            test_proxy,
            get_data_dir_info,
            migrate_data_dir,
            generate_claude_md,
            // Provider 命令
            list_providers,
            get_provider,
            get_default_provider,
            add_provider,
            update_provider,
            remove_provider,
            set_default_provider,
            read_config_dir_info,
            open_path_in_explorer,
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
            add_todo_subtask,
            update_todo_subtask,
            delete_todo_subtask,
            toggle_todo_subtask,
            reorder_todo_subtasks,
            // MCP 配置命令
            list_mcp_servers,
            get_mcp_server,
            upsert_mcp_server,
            remove_mcp_server,
            // Skill 命令
            list_skills,
            get_skill,
            save_skill,
            delete_skill,
            copy_skill,
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
            fs_search_files,
            fs_get_entry_info,
            // Screenshot 命令
            screenshot_capture,
            screenshot_crop_and_save,
            screenshot_update_shortcut
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                eprintln!("[cleanup] Application exiting, cleaning up resources...");
                terminal_cleanup.cleanup_all();
                history_cleanup.stop_all_watching();
                workspace_cleanup.stop_watcher();
                search_index_cleanup.stop_all_watching();
            }
        });
}
