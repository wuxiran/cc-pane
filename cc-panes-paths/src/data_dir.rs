//! CC-Panes 配置目录 / 数据目录解析。
//!
//! 规则与桌面端 `cc-panes-core::utils::app_paths` 一致：
//! - 配置目录：`CCPANES_CONFIG_DIR`（必须是绝对路径）→ `~/<APP_DIR_NAME>`；
//! - 数据目录：`CC_PANES_DATA_DIR`（非空）→ 配置目录。
//!
//! `APP_DIR_NAME` 按构建类型区分 dev（`.cc-panes-dev`）与 release（`.cc-panes`），
//! 让 dev 实例带的辅助二进制（hook 等）不会读到 release 实例的数据。

use std::path::{Path, PathBuf};

pub const RELEASE_APP_DIR_NAME: &str = ".cc-panes";
pub const DEV_APP_DIR_NAME: &str = ".cc-panes-dev";

/// dev/release 使用不同的应用目录，避免数据冲突。
pub const APP_DIR_NAME: &str = if cfg!(debug_assertions) {
    DEV_APP_DIR_NAME
} else {
    RELEASE_APP_DIR_NAME
};

/// 显式指定配置目录（绝对路径才生效）。
pub const APP_CONFIG_DIR_ENV: &str = "CCPANES_CONFIG_DIR";

/// 显式指定数据目录（ctl / hook 等外部进程识别当前实例用）。
pub const DATA_DIR_ENV: &str = "CC_PANES_DATA_DIR";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirResolver {
    home: Option<PathBuf>,
    config_dir_override: Option<PathBuf>,
    data_dir_override: Option<PathBuf>,
}

impl DataDirResolver {
    /// 从当前进程环境变量与用户主目录构造。
    pub fn from_env() -> Self {
        Self::new(
            dirs::home_dir(),
            std::env::var_os(APP_CONFIG_DIR_ENV).map(PathBuf::from),
            std::env::var(DATA_DIR_ENV).ok(),
        )
    }

    /// 显式构造，便于测试；`data_dir_override` 为空白时视为未设置。
    pub fn new(
        home: Option<PathBuf>,
        config_dir_override: Option<PathBuf>,
        data_dir_override: Option<String>,
    ) -> Self {
        Self {
            home,
            config_dir_override: config_dir_override.filter(|path| path.is_absolute()),
            data_dir_override: data_dir_override
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
        }
    }

    /// 配置目录：`CCPANES_CONFIG_DIR` → `~/<APP_DIR_NAME>`（无主目录时退到 `./<APP_DIR_NAME>`）。
    pub fn config_dir(&self) -> PathBuf {
        self.config_dir_override.clone().unwrap_or_else(|| {
            self.home
                .as_deref()
                .unwrap_or_else(|| Path::new("."))
                .join(APP_DIR_NAME)
        })
    }

    /// 数据目录：`CC_PANES_DATA_DIR` → 配置目录。
    pub fn data_dir(&self) -> PathBuf {
        self.data_dir_override
            .clone()
            .unwrap_or_else(|| self.config_dir())
    }

    pub fn workspaces_dir(&self) -> PathBuf {
        self.data_dir().join("workspaces")
    }

    pub fn memory_db_path(&self) -> PathBuf {
        self.data_dir().join("memory.db")
    }

    pub fn bin_dir(&self) -> PathBuf {
        self.config_dir().join("bin")
    }
}

/// 当前进程是否运行在 WSL 内（读 `/proc/sys/kernel/osrelease`，非 Linux 恒为 false）。
pub fn running_under_wsl() -> bool {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|release| {
            let release = release.to_ascii_lowercase();
            release.contains("microsoft") || release.contains("wsl")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        std::env::temp_dir().join("cc-panes-paths-home")
    }

    #[test]
    fn defaults_to_build_profile_dir_under_home() {
        let resolver = DataDirResolver::new(Some(home()), None, None);
        assert_eq!(resolver.config_dir(), home().join(APP_DIR_NAME));
        assert_eq!(resolver.data_dir(), home().join(APP_DIR_NAME));
        assert_eq!(
            resolver.memory_db_path(),
            home().join(APP_DIR_NAME).join("memory.db")
        );
    }

    #[test]
    fn data_dir_env_wins_over_config_dir() {
        let custom = std::env::temp_dir().join("custom-data");
        let resolver = DataDirResolver::new(
            Some(home()),
            None,
            Some(format!("  {}  ", custom.display())),
        );
        assert_eq!(resolver.data_dir(), custom);
        assert_eq!(resolver.workspaces_dir(), custom.join("workspaces"));
        assert_eq!(resolver.bin_dir(), home().join(APP_DIR_NAME).join("bin"));
    }

    #[test]
    fn blank_data_dir_and_relative_config_dir_are_ignored() {
        let resolver = DataDirResolver::new(
            Some(home()),
            Some(PathBuf::from("relative/dir")),
            Some("   ".to_string()),
        );
        assert_eq!(resolver.config_dir(), home().join(APP_DIR_NAME));
        assert_eq!(resolver.data_dir(), home().join(APP_DIR_NAME));
    }

    #[test]
    fn absolute_config_dir_override_is_used() {
        let config = std::env::temp_dir().join("cc-panes-config");
        let resolver = DataDirResolver::new(Some(home()), Some(config.clone()), None);
        assert_eq!(resolver.config_dir(), config);
        assert_eq!(resolver.data_dir(), config);
    }

    #[test]
    fn dev_and_release_names_differ() {
        assert_ne!(DEV_APP_DIR_NAME, RELEASE_APP_DIR_NAME);
        assert!(APP_DIR_NAME == DEV_APP_DIR_NAME || APP_DIR_NAME == RELEASE_APP_DIR_NAME);
    }
}
