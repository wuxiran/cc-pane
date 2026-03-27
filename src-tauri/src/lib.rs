mod commands;
pub mod constants;
pub mod emitter;
pub mod models;
pub mod pty;
pub mod repository;
pub mod services;
pub mod utils;

use commands::{
    // Journal 命令
    add_journal_session,
    add_launch_history,
    add_project,
    add_provider,
    // 日志命令
    get_log_dir,
    add_ssh_machine,
    add_ssh_project,
    add_todo_subtask,
    add_workspace_project,
    add_worktree,
    batch_update_todo_status,
    check_environment,
    check_ssh_connectivity,
    check_todo_reminders,
    clean_all_broken_sessions,
    clean_session_file,
    cleanup_project_history,
    clear_launch_history,
    close_window,
    compress_history,
    copy_skill,
    create_auto_label,
    create_popup_terminal_window,
    // Spec 命令
    create_spec,
    create_terminal_session,
    // Todo 命令
    create_todo,
    create_workspace,
    debug_encode_path,
    delete_label,
    delete_launch_history,
    delete_memory,
    delete_plan,
    delete_skill,
    delete_spec,
    delete_todo,
    delete_todo_subtask,
    delete_workspace,
    detect_claude_session,
    disable_hook,
    disable_hooks,
    enable_all_hooks,
    enable_hook,
    enable_hooks,
    enter_fullscreen,
    enter_mini_mode,
    exit_fullscreen,
    exit_mini_mode,
    extract_last_prompt,
    format_memory_for_injection,
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
    fs_search_files,
    fs_write_file,
    generate_claude_md,
    get_all_terminal_status,
    get_app_cwd,
    get_available_shells,
    // Local History - 分支感知 + Worktree
    get_current_branch,
    get_data_dir_info,
    get_default_provider,
    get_file_branches,
    get_git_branch,
    get_git_file_statuses,
    get_git_status,
    get_history_config,
    get_hooks_status,
    get_journal_index,
    get_mcp_server,
    get_memory,
    get_memory_stats,
    // Orchestrator 命令
    get_orchestrator_port,
    get_orchestrator_token,
    get_plan_content,
    get_popup_tab_data,
    get_project,
    get_provider,
    get_recent_changes,
    get_recent_journal,
    get_resource_stats,
    // Settings 命令
    get_settings,
    // 共享 MCP 命令
    get_shared_mcp_config,
    get_shared_mcp_status,
    import_shared_mcp_from_claude,
    upsert_shared_mcp_server,
    remove_shared_mcp_server,
    start_shared_mcp_server,
    stop_shared_mcp_server,
    restart_shared_mcp_server,
    update_shared_mcp_global_config,
    get_skill,
    get_spec_content,
    get_ssh_machine,
    get_terminal_output,
    get_todo,
    get_todo_stats,
    get_version_content,
    // Local History - Diff
    get_version_diff,
    get_versions_diff,
    get_windows_build_number,
    get_workflow,
    get_workspace,
    git_clone,
    git_fetch,
    git_pull,
    git_push,
    git_stash,
    git_stash_pop,
    handle_terminal_exit_spec,
    init_ccpanes,
    // Local History 命令
    init_project_history,
    is_fullscreen,
    // Worktree 命令
    is_git_repo,
    // Hooks 命令
    is_hooks_enabled,
    kill_claude_process,
    kill_claude_processes,
    kill_terminal,
    list_all_claude_sessions,
    list_claude_sessions,
    list_cli_tools,
    // Local History - 删除文件 + 压缩
    list_deleted_files,
    // Local History - 目录级历史 + 最近更改
    list_directory_changes,
    list_file_versions,
    list_file_versions_by_branch,
    list_labels,
    list_launch_history,
    // MCP 配置命令
    list_mcp_servers,
    list_memories,
    // Plan 命令
    list_plans,
    list_projects,
    // Provider 命令
    list_providers,
    // Skill 命令
    list_skills,
    list_specs,
    // SSH Machine 命令
    list_ssh_machines,
    // Workspace 命令
    list_workspaces,
    list_worktree_recent_changes,
    list_worktrees,
    maximize_window,
    migrate_data_dir,
    minimize_window,
    open_path_in_explorer,
    prepare_session_context,
    // Local History - 标签
    put_label,
    query_todos,
    read_config_dir_info,
    read_session_state,
    remove_mcp_server,
    remove_project,
    remove_provider,
    remove_ssh_machine,
    remove_workspace_project,
    remove_worktree,
    rename_workspace,
    reorder_todo_subtasks,
    reorder_todos,
    reorder_workspaces,
    resize_terminal,
    respond_orchestrator_query,
    restore_file_version,
    restore_to_label,
    save_skill,
    save_spec_content,
    save_workflow,
    scan_broken_sessions,
    // Process Monitor 命令
    scan_claude_processes,
    scan_workspace_directory,
    // Screenshot 命令
    screenshot_update_shortcut,
    // Memory 命令
    search_memory,
    set_decorations,
    set_default_provider,
    stop_project_history,
    store_memory,
    sync_spec_tasks,
    test_proxy,
    toggle_always_on_top,
    toggle_todo_my_day,
    toggle_todo_subtask,
    touch_launch_by_session,
    update_history_config,
    update_launch_last_prompt,
    update_launch_session_id,
    update_memory,
    update_project_alias,
    update_project_name,
    update_provider,
    update_settings,
    update_spec,
    update_ssh_machine,
    update_todo,
    update_todo_subtask,
    update_workspace,
    update_workspace_alias,
    update_workspace_path,
    update_workspace_project_alias,
    update_workspace_provider,
    upsert_mcp_server,
    write_terminal,
};
use repository::{Database, HistoryRepository, ProjectRepository, SpecRepository, TodoRepository};
use services::{
    FileSearchIndex, FileSystemService, HistoryService, HooksService, JournalService,
    LaunchHistoryService, McpConfigService, MemoryService, NotificationService,
    OrchestratorService, PlanService, ProcessMonitorService, ProjectService, ProviderService,
    ScreenshotService, SettingsService, SharedMcpService, SkillService, SpecService,
    SshMachineService, TerminalService, TodoService, WorkspaceService, WorktreeService,
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

/// macOS: 强制将 WKWebView 设为 NSWindow 的 firstResponder
/// 修复无边框窗口（decorations: false）下键盘输入失效的问题
#[cfg(target_os = "macos")]
fn force_webview_focus(window: &tauri::WebviewWindow) {
    // 层 1: JS eval 强制 document 获焦（同步，不依赖 with_webview 回调时序）
    let _ = window.eval("setTimeout(() => document.documentElement.focus(), 50)");

    // 层 2: 原生 ObjC（异步，通过事件循环）
    let _ = window.with_webview(|webview| unsafe {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSWindow};
        use objc2_web_kit::WKWebView;

        let wk_webview: &WKWebView = &*webview.inner().cast();
        let ns_window: &NSWindow = &*webview.ns_window().cast();

        // with_webview 回调在主线程执行，可安全获取 MainThreadMarker
        let mtm = MainThreadMarker::new().expect("with_webview callback must run on main thread");

        // 确保 app 激活 + 窗口为 key window
        let app = NSApplication::sharedApplication(mtm);
        app.activate();
        ns_window.makeKeyAndOrderFront(None);

        // 设置 firstResponder
        let ok = ns_window.makeFirstResponder(Some(wk_webview));
        eprintln!("[macos-focus] with_webview callback executed, makeFirstResponder={ok}");
    });
}

/// 截图进行中标志（模块级），托盘/菜单 show 守卫会检查此标志
static CAPTURING: AtomicBool = AtomicBool::new(false);

/// 触发截图流程：SetWindowDisplayAffinity 方案
/// Windows: 设置 WDA_EXCLUDEFROMCAPTURE → xcap 截屏 → 选区 → 裁剪保存 → 恢复 WDA_NONE
/// 非 Windows: Tauri hide → 截屏 → 选区 → 裁剪保存 → Tauri show
pub fn trigger_screenshot(app: &tauri::AppHandle) {
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
            match ScreenshotService::save_cropped(&capture.image, rect.x, rect.y, rect.w, rect.h) {
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

/// 获取 PATH 缓存文件路径
#[cfg(not(target_os = "windows"))]
fn get_path_cache_file() -> String {
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
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let path = strip_ansi_escapes(&raw);
            if path.is_empty() { None } else { Some(path) }
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
        if std::path::Path::new(d).is_dir() {
            dirs.push(d.clone());
        }
    }

    // nvm：找最新的 node 版本目录
    let nvm_dir = std::env::var("NVM_DIR")
        .unwrap_or_else(|_| format!("{home_str}/.nvm"));
    let nvm_versions = std::path::Path::new(&nvm_dir).join("versions/node");
    if nvm_versions.is_dir() {
        if let Ok(mut entries) = std::fs::read_dir(&nvm_versions) {
            let mut latest: Option<std::path::PathBuf> = None;
            while let Some(Ok(e)) = entries.next() {
                let p = e.path();
                if p.is_dir() {
                    // 取字典序最大的版本（v20 > v18 等）
                    if latest.as_ref().is_none_or(|l| p > *l) {
                        latest = Some(p);
                    }
                }
            }
            if let Some(node_dir) = latest {
                let bin = node_dir.join("bin");
                if bin.is_dir() {
                    dirs.push(bin.to_string_lossy().to_string());
                }
            }
        }
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
        if std::path::Path::new(d).is_dir() {
            dirs.push(d.to_string());
        }
    }

    // 追加当前 PATH 去重
    if let Ok(current) = std::env::var("PATH") {
        for entry in current.split(':') {
            if !entry.is_empty() && !dirs.contains(&entry.to_string()) {
                dirs.push(entry.to_string());
            }
        }
    }

    dirs.join(":")
}

/// 后台刷新 PATH 缓存 + 更新当前进程 PATH
#[cfg(not(target_os = "windows"))]
fn refresh_path_cache(cache_file: &str) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    if let Some(path) = resolve_path_from_shell(&shell) {
        let _ = write_path_cache(cache_file, &path);
        unsafe { std::env::set_var("PATH", &path); }
        eprintln!("[boot/bg] PATH cache refreshed + process PATH updated ({} entries)", path.split(':').count());
    }
}

/// 两层 PATH 加载：缓存 → well-known fallback（shell 全走后台）
#[cfg(not(target_os = "windows"))]
fn load_full_path() {
    let cache_file = get_path_cache_file();

    // 1. 尝试读缓存
    if let Ok(cached) = std::fs::read_to_string(&cache_file) {
        let cached = cached.trim().to_string();
        if !cached.is_empty() {
            eprintln!("[boot] PATH loaded from cache ({} entries)", cached.split(':').count());
            unsafe { std::env::set_var("PATH", &cached); }
            let cache_file_bg = cache_file.clone();
            std::thread::spawn(move || refresh_path_cache(&cache_file_bg));
            return;
        }
    }

    // 2. 无缓存：立即用 well-known paths（纯 fs 扫描，<1ms）
    let path = build_fallback_path();
    eprintln!("[boot] PATH set from well-known paths ({} entries), shell refresh in background", path.split(':').count());
    unsafe { std::env::set_var("PATH", &path); }

    // 后台 spawn shell 刷新缓存 + 更新当前进程 PATH
    std::thread::spawn(move || refresh_path_cache(&cache_file));
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
            let crash_dir = dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(crate::utils::APP_DIR_NAME);
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
    let cli_registry = {
        let mut reg = cc_cli_adapters::CliToolRegistry::new();
        reg.register(Arc::new(cc_cli_adapters::ClaudeAdapter::new()));
        reg.register(Arc::new(cc_cli_adapters::CodexAdapter::new()));
        Arc::new(reg)
    };
    let terminal_service = Arc::new(TerminalService::new(
        settings_service.clone(),
        provider_service.clone(),
        app_paths.clone(),
        cli_registry.clone(),
    ));
    // 注入 Spec 服务到 Terminal 服务（终端启动时自动注入 spec prompt）
    terminal_service.set_spec_service(spec_service.clone());

    let memory_service = Arc::new(
        MemoryService::new(app_paths.data_dir().join("memory.db")).unwrap_or_else(|e| {
            error!("MemoryService init failed: {}, using in-memory fallback", e);
            MemoryService::new_memory().expect("MemoryService fallback failed")
        }),
    );

    let ssh_machine_service = Arc::new(SshMachineService::new(
        app_paths.data_dir().join("ssh-machines.json"),
    ));

    let process_monitor_service = Arc::new(ProcessMonitorService::new());

    let shared_mcp_service = Arc::new(SharedMcpService::new(&app_paths));

    let popup_data_store = commands::PopupDataStore::default();
    let orchestrator_service = Arc::new(OrchestratorService::new());
    boot_mark!("all services created");

    // 保存引用用于退出时清理
    let terminal_cleanup = terminal_service.clone();
    let history_cleanup = history_service.clone();
    let workspace_cleanup = workspace_service.clone();
    let search_index_cleanup = search_index.clone();
    let shared_mcp_cleanup = shared_mcp_service.clone();

    boot_mark!("building tauri app...");
    tauri::Builder::default()
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
        .manage(memory_service)
        .manage(ssh_machine_service)
        .manage(process_monitor_service)
        .manage(shared_mcp_service.clone())
        .manage(popup_data_store)
        .manage(orchestrator_service.clone())
        .manage(cli_registry)
        .setup(move |app| {
            // Replay 早期启动打点到日志文件（此时 tauri-plugin-log 已初始化）
            info!("[boot] === CC-Panes starting ===");
            for (ms, msg) in &boot_marks {
                info!("[boot] +{}ms: {}", ms, msg);
            }
            info!("[boot] +{}ms: setup callback entered", boot_t0.elapsed().as_millis());

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

                        // ---- 注入默认 Skill 到各 CLI 工具的全局命令目录 ----
                        let t_skill = std::time::Instant::now();
                        let registry =
                            app.state::<Arc<cc_cli_adapters::CliToolRegistry>>();
                        let svc = cc_panes_core::services::DefaultSkillService::new(
                            resource_dir
                                .join("bundled-claude-config")
                                .join("default-skills"),
                        );
                        svc.inject_all(
                            registry.inner(),
                            env!("CARGO_PKG_VERSION"),
                        );
                        info!(
                            "[boot] skill injection took {}ms",
                            t_skill.elapsed().as_millis()
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[setup] Failed to resolve resource_dir, skill injection skipped: {}",
                            e
                        );
                    }
                }
            }

            info!("[boot] +{}ms: bundled config extracted", boot_t0.elapsed().as_millis());

            // ---- 注册 updater 插件（需在 setup 中注册以访问 app handle）----
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // ---- 注入 EventEmitter 和 SessionNotifier（setup 中才有 AppHandle）----
            {
                use emitter::{TauriEmitter, TauriSessionNotifier};
                let app_handle = app.handle().clone();
                let tauri_emitter: std::sync::Arc<dyn cc_panes_core::events::EventEmitter> =
                    Arc::new(TauriEmitter::new(app_handle.clone()));

                // 注入到 TerminalService
                let term_svc = app.state::<Arc<TerminalService>>();
                term_svc.set_emitter(tauri_emitter.clone());
                let notif_svc = app.state::<Arc<NotificationService>>();
                let settings_svc = app.state::<Arc<SettingsService>>();
                term_svc.set_notifier(Arc::new(TauriSessionNotifier::new(
                    app_handle.clone(),
                    notif_svc.inner().clone(),
                    settings_svc.inner().clone(),
                )));

                // ---- 启动 workspace 目录监控 ----
                let ws_svc = app.state::<Arc<WorkspaceService>>();
                ws_svc.start_watcher(tauri_emitter);
            }
            info!("[boot] +{}ms: emitters injected + workspace watcher started", boot_t0.elapsed().as_millis());

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
                        if let Err(e) =
                            app.global_shortcut()
                                .on_shortcut(shortcut, move |_app, _sc, event| {
                                    if event.state
                                        == tauri_plugin_global_shortcut::ShortcutState::Pressed
                                    {
                                        trigger_screenshot(&app_handle);
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
            info!("[boot] +{}ms: orchestrator started", boot_t0.elapsed().as_millis());

            // ---- 共享 MCP Server 启动 ----
            {
                let svc = app.state::<Arc<SharedMcpService>>().inner().clone();
                let term_svc = app.state::<Arc<TerminalService>>().inner().clone();
                svc.start_all();
                svc.start_health_check();
                // 注入到 TerminalService
                term_svc.set_shared_mcp_service(svc);
            }
            info!("[boot] +{}ms: shared MCP servers started", boot_t0.elapsed().as_millis());

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
                            NSWindow, NSWindowStyleMask, NSWindowTitleVisibility,
                        };

                        let ns_window: &NSWindow = &*webview.ns_window().cast();

                        // 1. 添加 decorations（标题栏 + 红绿灯按钮）
                        let mut mask = ns_window.styleMask();
                        mask.insert(NSWindowStyleMask::Titled);
                        mask.insert(NSWindowStyleMask::FullSizeContentView);
                        ns_window.setStyleMask(mask);

                        // 2. 标题栏透明 + 隐藏标题文字
                        ns_window.setTitlebarAppearsTransparent(true);
                        ns_window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
                    });
                    info!("[boot] macOS: configured titlebar overlay via NSWindow API");

                    force_webview_focus(&window);
                    info!("[boot] macOS: forced WKWebView as firstResponder");
                }
            }

            info!("[boot] +{}ms: === setup complete ===", boot_t0.elapsed().as_millis());
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        // 主窗口关闭 → 隐藏到托盘（不退出）
                        let _ = window.hide();
                        api.prevent_close();
                    }
                    // 弹出窗口正常关闭，不拦截
                }
                #[cfg(target_os = "macos")]
                WindowEvent::Focused(true) => {
                    if window.label() == "main" {
                        if let Some(ww) = window.app_handle().get_webview_window("main") {
                            force_webview_focus(&ww);
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
            check_environment,
            list_cli_tools,
            get_terminal_output,
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
            get_popup_tab_data,
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
            add_ssh_project,
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
            get_log_dir,
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
            respond_orchestrator_query,
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
            // Process Monitor 命令
            scan_claude_processes,
            kill_claude_process,
            kill_claude_processes,
            get_resource_stats,
            // 共享 MCP 命令
            get_shared_mcp_config,
            get_shared_mcp_status,
            upsert_shared_mcp_server,
            remove_shared_mcp_server,
            start_shared_mcp_server,
            stop_shared_mcp_server,
            restart_shared_mcp_server,
            update_shared_mcp_global_config,
            import_shared_mcp_from_claude
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                info!("[cleanup] Application exiting, cleaning up resources...");
                shared_mcp_cleanup.stop_health_check();
                shared_mcp_cleanup.stop_all();
                terminal_cleanup.cleanup_all();
                history_cleanup.stop_all_watching();
                workspace_cleanup.stop_watcher();
                search_index_cleanup.stop_all_watching();
            }
        });
}
