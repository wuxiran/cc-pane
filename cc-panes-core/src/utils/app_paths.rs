use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// dev/release 使用不同的应用目录，避免数据冲突
pub const APP_DIR_NAME: &str = if cfg!(debug_assertions) { ".cc-panes-dev" } else { ".cc-panes" };

/// 统一路径管理
///
/// - `config_dir` 固定在 `~/.cc-panes/`（release）或 `~/.cc-panes-dev/`（dev）
/// - `data_dir` 可配置，默认与 config_dir 相同
pub struct AppPaths {
    config_dir: PathBuf,
    data_dir: PathBuf,
}

impl AppPaths {
    pub fn new(data_dir: Option<String>) -> Self {
        let config_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(APP_DIR_NAME);

        let data_dir = match data_dir {
            Some(ref dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => config_dir.clone(),
        };

        // 确保目录存在
        if let Err(e) = std::fs::create_dir_all(&config_dir) {
            warn!("Failed to create config directory {}: {}", config_dir.display(), e);
        }
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            warn!("Failed to create data directory {}: {}", data_dir.display(), e);
        }

        Self {
            config_dir,
            data_dir,
        }
    }

    /// SQLite 数据库路径
    pub fn database_path(&self) -> PathBuf {
        self.data_dir.join("data.db")
    }

    /// providers.json 路径
    pub fn providers_path(&self) -> PathBuf {
        self.data_dir.join("providers.json")
    }

    /// workspaces 目录
    pub fn workspaces_dir(&self) -> PathBuf {
        self.data_dir.join("workspaces")
    }

    /// 指定工作空间的目录
    pub fn workspace_dir(&self, name: &str) -> PathBuf {
        self.workspaces_dir().join(name)
    }

    /// 当前数据目录
    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// 默认数据目录（即 config_dir）
    pub fn default_data_dir(&self) -> &std::path::Path {
        &self.config_dir
    }

    /// 是否使用默认位置
    pub fn is_default(&self) -> bool {
        self.config_dir == self.data_dir
    }

    /// 计算数据目录总大小（字节）
    pub fn data_dir_size(&self) -> u64 {
        dir_size(&self.data_dir)
    }

    /// 将打包的 .claude/ 配置从资源目录提取到数据目录
    /// 每次启动都覆盖，确保使用最新版本
    pub fn extract_bundled_claude_config(&self, resource_dir: &Path) {
        let src_base = resource_dir.join("bundled-claude-config");
        if !src_base.exists() {
            info!("[app_paths] No bundled-claude-config found at {}, skipping extraction", src_base.display());
            return;
        }

        // 清空目标目录后再复制，避免旧版本残留文件
        let dest_commands = self.data_dir.join(".claude").join("commands").join("ccbook");
        let dest_agents = self.data_dir.join(".claude").join("agents");
        Self::clean_and_copy(
            &src_base.join(".claude").join("commands").join("ccbook"),
            &dest_commands,
        );
        Self::clean_and_copy(
            &src_base.join(".claude").join("agents"),
            &dest_agents,
        );

        // 复制 CLAUDE.md
        let src_claude_md = src_base.join("CLAUDE.md");
        if src_claude_md.exists() {
            let dest = self.data_dir.join("CLAUDE.md");
            match std::fs::copy(&src_claude_md, &dest) {
                Ok(_) => info!("[app_paths] Extracted CLAUDE.md to {}", dest.display()),
                Err(e) => warn!("[app_paths] Failed to copy CLAUDE.md: {}", e),
            }
        }

        info!("[app_paths] Bundled claude config extracted to {}", self.data_dir.display());
    }

    /// 清空目标目录后再递归复制，确保与源完全一致
    fn clean_and_copy(src: &Path, dest: &Path) {
        if !src.exists() {
            return;
        }
        // 先删除目标目录（忽略不存在的情况）
        let _ = std::fs::remove_dir_all(dest);
        Self::copy_dir_recursive(src, dest);
    }

    /// 递归复制目录
    fn copy_dir_recursive(src: &Path, dest: &Path) {
        if !src.exists() {
            return;
        }
        if let Err(e) = std::fs::create_dir_all(dest) {
            warn!("[app_paths] Failed to create dir {}: {}", dest.display(), e);
            return;
        }
        if let Ok(entries) = std::fs::read_dir(src) {
            for entry in entries.flatten() {
                let dest_path = dest.join(entry.file_name());
                if entry.path().is_dir() {
                    Self::copy_dir_recursive(&entry.path(), &dest_path);
                } else {
                    let _ = std::fs::copy(entry.path(), &dest_path);
                }
            }
        }
    }
}

/// 递归计算目录大小（不跟随符号链接）
fn dir_size(path: &std::path::Path) -> u64 {
    let mut total: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            // 使用 symlink_metadata 避免跟随符号链接导致无限递归
            if let Ok(meta) = std::fs::symlink_metadata(entry.path()) {
                if meta.is_file() {
                    total += meta.len();
                } else if meta.is_dir() {
                    // symlink_metadata 对符号链接返回 is_symlink()=true, is_dir()=false
                    // 因此此处只处理真实目录，不会跟随指向目录的符号链接
                    total += dir_size(&entry.path());
                }
            }
        }
    }
    total
}
