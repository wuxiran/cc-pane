use crate::models::settings::AppSettings;
use crate::services::SettingsService;
use crate::utils::AppResult;
use serde::Serialize;
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use crate::utils::AppPaths;

/// 获取设置
#[tauri::command]
pub fn get_settings(
    service: State<'_, Arc<SettingsService>>,
) -> AppResult<AppSettings> {
    Ok(service.get_settings())
}

/// 更新设置
#[tauri::command]
pub fn update_settings(
    service: State<'_, Arc<SettingsService>>,
    settings: AppSettings,
) -> AppResult<()> {
    Ok(service.update_settings(settings)?)
}

/// 测试代理连接
#[tauri::command]
pub fn test_proxy(
    service: State<'_, Arc<SettingsService>>,
) -> AppResult<bool> {
    let settings = service.get_settings();
    let proxy = &settings.proxy;
    if !proxy.enabled || proxy.host.is_empty() {
        return Err("代理未启用或未配置".into());
    }

    let addr = format!("{}:{}", proxy.host, proxy.port);
    let socket_addr: std::net::SocketAddr = addr
        .parse()
        .map_err(|e| format!("地址解析失败: {}", e))?;

    TcpStream::connect_timeout(&socket_addr, Duration::from_secs(5))
        .map(|_| true)
        .map_err(|e| format!("无法连接到代理 {}: {}", addr, e).into())
}

/// 数据目录信息
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    pub current_path: String,
    pub default_path: String,
    pub is_default: bool,
    pub size_bytes: u64,
}

/// 获取数据目录信息
#[tauri::command]
pub fn get_data_dir_info(
    app_paths: State<'_, Arc<AppPaths>>,
) -> AppResult<DataDirInfo> {
    Ok(DataDirInfo {
        current_path: app_paths.data_dir().to_string_lossy().to_string(),
        default_path: app_paths.default_data_dir().to_string_lossy().to_string(),
        is_default: app_paths.is_default(),
        size_bytes: app_paths.data_dir_size(),
    })
}

/// 迁移数据目录
///
/// 1. 验证目标路径可写
/// 2. 复制 data.db, providers.json, workspaces/
/// 3. 校验文件大小一致
/// 4. 更新 config.toml 中的 data_dir
/// 5. 不删除旧数据
#[tauri::command]
pub fn migrate_data_dir(
    app_paths: State<'_, Arc<AppPaths>>,
    settings_service: State<'_, Arc<SettingsService>>,
    target_dir: String,
) -> AppResult<()> {
    let target = Path::new(&target_dir);
    let source = app_paths.data_dir();

    // 路径安全校验：禁止迁移到系统目录
    let forbidden_prefixes: &[&str] = if cfg!(windows) {
        &["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\System32"]
    } else {
        &["/etc", "/usr", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev"]
    };
    let target_str = target.to_string_lossy();
    for prefix in forbidden_prefixes {
        if target_str.starts_with(prefix) {
            return Err(format!("不允许迁移到系统目录: {}", prefix).into());
        }
    }

    // 如果目标目录已存在，必须为空目录
    if target.exists() && target.is_dir() {
        let is_empty = std::fs::read_dir(target)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            // 允许与源目录相同（后续逻辑会拦截）
            let target_canonical = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
            let source_canonical = std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
            if target_canonical != source_canonical {
                return Err("目标目录必须为空".into());
            }
        }
    }

    // 不能迁移到相同目录（使用 canonicalize 规范化路径，解决 Windows 大小写问题）
    let target_canonical = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let source_canonical = std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    if target_canonical == source_canonical {
        return Err("目标目录与当前数据目录相同".into());
    }

    // 创建目标目录
    std::fs::create_dir_all(target)
        .map_err(|e| format!("无法创建目标目录: {}", e))?;

    // 验证可写
    let test_file = target.join(".write_test");
    std::fs::write(&test_file, "test")
        .map_err(|e| format!("目标目录不可写: {}", e))?;
    let _ = std::fs::remove_file(&test_file);

    // 复制 data.db
    copy_if_exists(
        &source.join("data.db"),
        &target.join("data.db"),
    )?;

    // 复制 providers.json
    copy_if_exists(
        &source.join("providers.json"),
        &target.join("providers.json"),
    )?;

    // 递归复制 workspaces/
    let src_ws = source.join("workspaces");
    let dst_ws = target.join("workspaces");
    if src_ws.exists() {
        copy_dir_recursive(&src_ws, &dst_ws)?;
    }

    // 校验文件完整性（文件大小一致）
    verify_copy(&source.join("data.db"), &target.join("data.db"))?;
    verify_copy(&source.join("providers.json"), &target.join("providers.json"))?;

    // 校验 workspaces 目录的文件数量一致
    if src_ws.exists() {
        let src_count = count_files(&src_ws);
        let dst_count = count_files(&dst_ws);
        if src_count != dst_count {
            return Err(format!(
                "workspaces 目录文件数量不一致 (源: {} 个, 目标: {} 个)",
                src_count, dst_count
            ).into());
        }
    }

    // 更新设置中的 data_dir
    // 如果目标路径是默认路径，则设为 None（恢复默认）
    let default_path = app_paths.default_data_dir();
    let target_is_default = std::fs::canonicalize(target)
        .unwrap_or_else(|_| target.to_path_buf())
        == std::fs::canonicalize(default_path)
            .unwrap_or_else(|_| default_path.to_path_buf());

    let mut current_settings = settings_service.get_settings();
    current_settings.general.data_dir = if target_is_default {
        None
    } else {
        Some(target_dir)
    };
    settings_service.update_settings(current_settings)
        .map_err(|e| format!("更新配置失败: {}", e))?;

    Ok(())
}

/// 复制文件（如果源文件存在）
fn copy_if_exists(src: &Path, dst: &Path) -> AppResult<()> {
    if src.exists() {
        std::fs::copy(src, dst)
            .map_err(|e| format!("复制 {} 失败: {}", src.display(), e))?;
    }
    Ok(())
}

/// 递归复制目录（跳过符号链接）
fn copy_dir_recursive(src: &Path, dst: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("创建目录 {} 失败: {}", dst.display(), e))?;

    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("读取目录 {} 失败: {}", src.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        // 使用 symlink_metadata 检查，跳过符号链接
        let meta = std::fs::symlink_metadata(&src_path)
            .map_err(|e| format!("读取元数据失败 {}: {}", src_path.display(), e))?;
        if meta.is_symlink() {
            continue;
        }

        if meta.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if meta.is_file() {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("复制 {} 失败: {}", src_path.display(), e))?;
        }
    }

    Ok(())
}

/// 递归统计目录中的文件数量
fn count_files(path: &Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                count += 1;
            } else if p.is_dir() {
                count += count_files(&p);
            }
        }
    }
    count
}

/// 校验复制的文件大小一致
fn verify_copy(src: &Path, dst: &Path) -> AppResult<()> {
    if !src.exists() {
        return Ok(());
    }
    if !dst.exists() {
        return Err(format!("目标文件不存在: {}", dst.display()).into());
    }

    let src_size = std::fs::metadata(src)
        .map_err(|e| format!("读取源文件元数据失败: {}", e))?.len();
    let dst_size = std::fs::metadata(dst)
        .map_err(|e| format!("读取目标文件元数据失败: {}", e))?.len();

    if src_size != dst_size {
        return Err(format!(
            "文件大小不一致: {} (源: {} 字节, 目标: {} 字节)",
            src.display(), src_size, dst_size
        ).into());
    }

    Ok(())
}
