use std::path::PathBuf;

/// 统一路径管理
///
/// - `config_dir` 固定在 `~/.cc-panes/`，存放引导配置 config.toml
/// - `data_dir` 可配置，默认也是 `~/.cc-panes/`，存放数据库、providers、workspaces
pub struct AppPaths {
    config_dir: PathBuf,
    data_dir: PathBuf,
}

impl AppPaths {
    pub fn new(data_dir: Option<String>) -> Self {
        let config_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".cc-panes");

        let data_dir = match data_dir {
            Some(ref dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => config_dir.clone(),
        };

        // 确保目录存在
        if let Err(e) = std::fs::create_dir_all(&config_dir) {
            eprintln!("警告: 无法创建配置目录 {}: {}", config_dir.display(), e);
        }
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            eprintln!("警告: 无法创建数据目录 {}: {}", data_dir.display(), e);
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
