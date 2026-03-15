pub mod constants;
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
    enter_fullscreen, exit_fullscreen, get_all_terminal_status, get_available_shells, get_windows_build_number, check_environment,
    get_git_branch, get_git_status, get_git_file_statuses, get_project,
    git_clone, git_fetch, git_pull, git_push, git_stash, git_stash_pop, is_fullscreen, kill_terminal,
    list_all_claude_sessions, list_claude_sessions, scan_broken_sessions,
    clean_session_file, clean_all_broken_sessions, extract_last_prompt,
    list_launch_history, list_projects,
    remove_project, resize_terminal, set_decorations, toggle_always_on_top, enter_mini_mode, exit_mini_mode,
    close_window, minimize_window, maximize_window, get_app_cwd, create_popup_terminal_window,
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
    // Spec 命令
    create_spec, list_specs, get_spec_content, save_spec_content,
    update_spec, delete_spec, sync_spec_tasks, handle_terminal_exit_spec,
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
    screenshot_update_shortcut,
    // Orchestrator 命令
    get_orchestrator_port, get_orchestrator_token, respond_orchestrator_query,
};
use repository::{Database, ProjectRepository, HistoryRepository, TodoRepository, SpecRepository};
use services::{ProjectService, TerminalService, HistoryService, HooksService, JournalService, WorktreeService, WorkspaceService, SettingsService, ProviderService, NotificationService, LaunchHistoryService, TodoService, SpecService, McpConfigService, SkillService, PlanService, FileSystemService, FileSearchIndex, ScreenshotService, OrchestratorService};
use utils::AppPaths;
use std::sync::Arc;

use std::sync::atomic::{AtomicBool, Ordering};
use tracing::{debug, error, info};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// 截图进行中标志（模块级），托盘/菜单 show 守卫会检查此标志
static CAPTURING: AtomicBool = AtomicBool::new(false);

/// 触发截图流程：SetWindowDisplayAffinity 方案
/// Windows: 设置 WDA_EXCLUDEFROMCAPTURE → xcap 截屏 → 选区 → 裁剪保存 → 恢复 WDA_NONE
/// 非 Windows: Tauri hide → 截屏 → 选区 → 裁剪保存 → Tauri show
pub fn trigger_screenshot(app: &tauri::AppHandle) {
    use std::time::Instant;

    if CAPTURING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return;
    }

    // 获取主窗口 HWND（isize 可安全跨线程传递）
    #[cfg(target_os = "windows")]
    let main_hwnd: Option<isize> = app.get_webview_window("main").and_then(|w| {
        w.hwnd().ok().map(|h| h.0 as isize)
    });

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
            unsafe { let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE); }
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
                error!("[screenshot] +{}ms: capture failed: {}", t0.elapsed().as_millis(), e);
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

        debug!("[screenshot] +{}ms: user finished selection", t0.elapsed().as_millis());

        // 3. 如果有选区 → 从内存裁剪 + 保存 PNG + 复制路径到剪贴板
        if let Some(rect) = selection {
            debug!("[screenshot] +{}ms: image ready in memory", t0.elapsed().as_millis());
            match ScreenshotService::save_cropped(
                &capture.image,
                rect.x, rect.y, rect.w, rect.h,
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
                    error!("[screenshot] +{}ms: crop failed: {}", t0.elapsed().as_millis(), e);
                }
            }
        } else {
            debug!("[screenshot] +{}ms: user cancelled", t0.elapsed().as_millis());
        }

        // 4. 恢复 DisplayAffinity / 窗口可见性
        #[cfg(target_os = "windows")]
        restore_display_affinity(main_hwnd);
        #[cfg(not(target_os = "windows"))]
        restore_main_window_tauri(&app);

        debug!("[screenshot] +{}ms: display affinity restored", t0.elapsed().as_millis());
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
        unsafe { let _ = SetWindowDisplayAffinity(hwnd, WDA_NONE); }
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

// ============ 应用入口 ============

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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

    // 2. 构造路径管理器
    let app_paths = Arc::new(AppPaths::new(data_dir));

    // 3. 各服务用 app_paths 初始化
    let db = match Database::new(app_paths.database_path()) {
        Ok(db) => Arc::new(db),
        Err(e) => {
            error!("Database initialization failed: {}, trying in-memory fallback", e);
            Arc::new(Database::new_fallback().unwrap_or_else(|e2| {
                panic!("Database initialization completely failed (including fallback): {}", e2);
            }))
        }
    };
    let project_repo = Arc::new(ProjectRepository::new(db.clone()));
    let history_repo = Arc::new(HistoryRepository::new(db.clone()));
    let todo_repo = Arc::new(TodoRepository::new(db.clone()));
    let spec_repo = Arc::new(SpecRepository::new(db));
    let launch_history_service = Arc::new(LaunchHistoryService::new(history_repo));
    let todo_service = Arc::new(TodoService::new(todo_repo));
    let spec_service = Arc::new(SpecService::new(spec_repo, todo_service.clone()));
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
    // 注入 Spec 服务到 Terminal 服务（终端启动时自动注入 spec prompt）
    terminal_service.set_spec_service(spec_service.clone());

    let orchestrator_service = Arc::new(OrchestratorService::new());

    // 保存引用用于退出时清理
    let terminal_cleanup = terminal_service.clone();
    let history_cleanup = history_service.clone();
    let workspace_cleanup = workspace_service.clone();
    let search_index_cleanup = search_index.clone();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log_level)
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
        .manage(spec_service)
        .manage(mcp_config_service)
        .manage(skill_service)
        .manage(plan_service)
        .manage(filesystem_service)
        .manage(orchestrator_service.clone())
        .setup(|app| {
            // ---- 提取打包的 .claude/ 配置到数据目录（Release 模式）----
            {
                let paths = app.state::<Arc<AppPaths>>();
                if let Ok(resource_dir) = app.path().resource_dir() {
                    paths.extract_bundled_claude_config(&resource_dir);
                }
            }

            // ---- 注册 updater 插件（需在 setup 中注册以访问 app handle）----
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            // ---- 启动 workspace 目录监控 ----
            let ws_svc = app.state::<Arc<WorkspaceService>>();
            ws_svc.start_watcher(app.handle().clone());

            // ---- 注册截图全局快捷键（仅 Windows，macOS 截图功能暂未实现）----
            #[cfg(target_os = "windows")]
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
                            error!("[screenshot] Failed to register shortcut '{}': {}", shortcut_str, e);
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
                let prov_svc = app.state::<Arc<ProviderService>>();
                let proj_svc = app.state::<Arc<ProjectService>>();
                let ws_svc_orch = app.state::<Arc<WorkspaceService>>();
                let todo_svc = app.state::<Arc<TodoService>>();
                let spec_svc = app.state::<Arc<SpecService>>();
                let skill_svc = app.state::<Arc<SkillService>>();
                let lh_svc = app.state::<Arc<LaunchHistoryService>>();
                let paths = app.state::<Arc<AppPaths>>();
                if let Err(e) = orch_svc.start(
                    term_svc.inner().clone(),
                    prov_svc.inner().clone(),
                    proj_svc.inner().clone(),
                    ws_svc_orch.inner().clone(),
                    todo_svc.inner().clone(),
                    spec_svc.inner().clone(),
                    skill_svc.inner().clone(),
                    lh_svc.inner().clone(),
                    app.handle().clone(),
                    paths.inner().clone(),
                ) {
                    error!("[orchestrator] Failed to start: {}", e);
                }
                // 注入 Orchestrator 连接信息到 TerminalService
                if let Some(port) = orch_svc.port() {
                    term_svc.set_orchestrator_info(port, orch_svc.token().to_string());
                }
            }

            // ---- 系统托盘 ----
            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let icon =
                tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

            let tooltip = if cfg!(debug_assertions) { "CC-Panes [DEV]" } else { "CC-Panes" };
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

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // 主窗口关闭 → 隐藏到托盘（不退出）
                    let _ = window.hide();
                    api.prevent_close();
                }
                // 弹出窗口正常关闭，不拦截
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
            check_environment,
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
            create_popup_terminal_window,
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
            // Spec 命令
            create_spec,
            list_specs,
            get_spec_content,
            save_spec_content,
            update_spec,
            delete_spec,
            sync_spec_tasks,
            handle_terminal_exit_spec,
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
            screenshot_update_shortcut,
            // Orchestrator 命令
            get_orchestrator_port,
            get_orchestrator_token,
            respond_orchestrator_query
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                info!("[cleanup] Application exiting, cleaning up resources...");
                terminal_cleanup.cleanup_all();
                history_cleanup.stop_all_watching();
                workspace_cleanup.stop_watcher();
                search_index_cleanup.stop_all_watching();
            }
        });
}
