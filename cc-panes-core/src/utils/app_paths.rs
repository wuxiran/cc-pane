use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// dev/release 使用不同的应用目录，避免数据冲突
pub const APP_DIR_NAME: &str = if cfg!(debug_assertions) {
    ".cc-panes-dev"
} else {
    ".cc-panes"
};

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
            warn!(
                "Failed to create config directory {}: {}",
                config_dir.display(),
                e
            );
        }
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            warn!(
                "Failed to create data directory {}: {}",
                data_dir.display(),
                e
            );
        }

        let paths = Self {
            config_dir,
            data_dir,
        };
        paths.ensure_control_center_layout();
        paths
    }

    /// SQLite 数据库路径
    pub fn database_path(&self) -> PathBuf {
        self.data_dir.join("data.db")
    }

    /// providers.json 路径
    pub fn providers_path(&self) -> PathBuf {
        self.data_dir.join("providers.json")
    }

    /// launch profiles 目标目录（后续版本使用；当前仍兼容根目录 launch-profiles.json）
    pub fn launch_profiles_dir(&self) -> PathBuf {
        self.data_dir.join("launch-profiles")
    }

    /// launch_profiles.json 路径
    pub fn launch_profiles_path(&self) -> PathBuf {
        self.data_dir.join("launch-profiles.json")
    }

    /// 终端输出文件目录
    pub fn sessions_dir(&self) -> PathBuf {
        self.data_dir.join("sessions")
    }

    /// runtime 目录（运行期临时/会话文件的目标根目录）
    pub fn runtime_dir(&self) -> PathBuf {
        self.data_dir.join("runtime")
    }

    /// runtime/sessions 目标目录（后续会替代根 sessions/ 的部分运行期用途）
    pub fn runtime_sessions_dir(&self) -> PathBuf {
        self.runtime_dir().join("sessions")
    }

    /// 指定会话的输出文件路径
    pub fn session_output_path(&self, session_id: &str) -> PathBuf {
        self.sessions_dir().join(format!("{}.output", session_id))
    }

    /// workspaces 目录
    pub fn workspaces_dir(&self) -> PathBuf {
        self.data_dir.join("workspaces")
    }

    /// memory 目标目录。
    ///
    /// 当前 Memory 仍以 memory.db/SQLite 为 source of truth；该目录为后续
    /// Markdown-first 迁移预留，并在启动时预创建。
    pub fn memory_dir(&self) -> PathBuf {
        self.data_dir.join("memory")
    }

    /// MCP 目标目录。
    ///
    /// 当前 shared MCP 配置仍读取根目录 shared-mcp.json；该目录和路径方法
    /// 供后续无破坏迁移使用。
    pub fn mcp_dir(&self) -> PathBuf {
        self.data_dir.join("mcp")
    }

    /// shared MCP 目标配置路径（当前未切换读写行为）。
    pub fn shared_mcp_path(&self) -> PathBuf {
        self.mcp_dir().join("shared-mcp.json")
    }

    /// skills 目标目录。
    pub fn skills_dir(&self) -> PathBuf {
        self.data_dir.join("skills")
    }

    /// 用户自定义 skills 目标目录。
    pub fn user_skills_dir(&self) -> PathBuf {
        self.skills_dir().join("user")
    }

    /// 内置 skills 目标目录。
    pub fn builtin_skills_dir(&self) -> PathBuf {
        self.skills_dir().join("builtin")
    }

    /// 指定工作空间的目录
    pub fn workspace_dir(&self, name: &str) -> PathBuf {
        self.workspaces_dir().join(name)
    }

    /// Workspace snapshot metadata directory.
    pub fn workspace_snapshots_dir(&self, workspace_id: &str) -> PathBuf {
        self.workspace_dir(workspace_id).join("snapshots")
    }

    /// Workspace snapshot metadata file.
    pub fn workspace_snapshot_path(&self, workspace_id: &str, snapshot_id: &str) -> PathBuf {
        self.workspace_snapshots_dir(workspace_id)
            .join(snapshot_id)
            .join("snapshot.json")
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

    /// 准备 CC-Panes 用户级控制中心目录结构。
    ///
    /// 该方法只创建目录，不迁移、复制或重写既有文件，避免影响旧版本
    /// `providers.json`、`launch-profiles.json`、`shared-mcp.json`、`memory.db`
    /// 等兼容读写路径。
    pub fn ensure_control_center_layout(&self) {
        let dirs = [
            self.workspaces_dir(),
            self.launch_profiles_dir(),
            self.memory_dir(),
            self.mcp_dir(),
            self.user_skills_dir(),
            self.builtin_skills_dir(),
            self.runtime_sessions_dir(),
        ];

        for dir in dirs {
            if let Err(e) = std::fs::create_dir_all(&dir) {
                warn!(
                    "[app_paths] Failed to create control center directory {}: {}",
                    dir.display(),
                    e
                );
            }
        }
    }

    /// 将打包的 .claude/ 配置从资源目录提取到数据目录
    /// 每次启动都覆盖，确保使用最新版本
    pub fn extract_bundled_claude_config(&self, resource_dir: &Path) {
        let src_base = resource_dir.join("resources").join("claude-bundle");
        if !src_base.exists() {
            info!(
                "[app_paths] No claude-bundle found at {}, skipping extraction",
                src_base.display()
            );
            return;
        }

        // 清空目标目录后再复制，避免旧版本残留文件
        let dest_commands = self
            .data_dir
            .join(".claude")
            .join("commands")
            .join("ccbook");
        let dest_agents = self.data_dir.join(".claude").join("agents");
        Self::clean_and_copy(
            &src_base.join(".claude").join("commands").join("ccbook"),
            &dest_commands,
        );
        Self::clean_and_copy(&src_base.join(".claude").join("agents"), &dest_agents);

        // 复制 CLAUDE.md
        let src_claude_md = src_base.join("CLAUDE.md");
        if src_claude_md.exists() {
            let dest = self.data_dir.join("CLAUDE.md");
            match std::fs::copy(&src_claude_md, &dest) {
                Ok(_) => info!("[app_paths] Extracted CLAUDE.md to {}", dest.display()),
                Err(e) => warn!("[app_paths] Failed to copy CLAUDE.md: {}", e),
            }
        }

        info!(
            "[app_paths] Bundled claude config extracted to {}",
            self.data_dir.display()
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_paths(tmp: &TempDir) -> AppPaths {
        AppPaths::new(Some(tmp.path().to_string_lossy().to_string()))
    }

    #[test]
    fn custom_data_dir_is_used_and_not_default() {
        let tmp = TempDir::new().unwrap();
        let paths = make_paths(&tmp);
        assert_eq!(paths.data_dir(), tmp.path());
        assert!(!paths.is_default());
        assert!(paths.default_data_dir().ends_with(APP_DIR_NAME));
    }

    #[test]
    fn empty_data_dir_falls_back_to_config_dir() {
        let paths = AppPaths::new(Some(String::new()));
        assert!(paths.is_default());
        assert_eq!(paths.data_dir(), paths.default_data_dir());
    }

    #[test]
    fn path_getters_compose_under_data_dir() {
        let tmp = TempDir::new().unwrap();
        let paths = make_paths(&tmp);
        let base = tmp.path();

        assert_eq!(paths.database_path(), base.join("data.db"));
        assert_eq!(paths.providers_path(), base.join("providers.json"));
        assert_eq!(
            paths.launch_profiles_path(),
            base.join("launch-profiles.json")
        );
        assert_eq!(paths.launch_profiles_dir(), base.join("launch-profiles"));
        assert_eq!(paths.sessions_dir(), base.join("sessions"));
        assert_eq!(
            paths.runtime_sessions_dir(),
            base.join("runtime").join("sessions")
        );
        assert_eq!(
            paths.session_output_path("abc"),
            base.join("sessions").join("abc.output")
        );
        assert_eq!(
            paths.workspace_dir("ws"),
            base.join("workspaces").join("ws")
        );
        assert_eq!(
            paths.workspace_snapshot_path("ws", "snap"),
            base.join("workspaces")
                .join("ws")
                .join("snapshots")
                .join("snap")
                .join("snapshot.json")
        );
        assert_eq!(
            paths.shared_mcp_path(),
            base.join("mcp").join("shared-mcp.json")
        );
        assert_eq!(paths.user_skills_dir(), base.join("skills").join("user"));
        assert_eq!(
            paths.builtin_skills_dir(),
            base.join("skills").join("builtin")
        );
    }

    #[test]
    fn new_precreates_control_center_layout() {
        let tmp = TempDir::new().unwrap();
        let paths = make_paths(&tmp);

        assert!(paths.workspaces_dir().is_dir());
        assert!(paths.launch_profiles_dir().is_dir());
        assert!(paths.memory_dir().is_dir());
        assert!(paths.mcp_dir().is_dir());
        assert!(paths.user_skills_dir().is_dir());
        assert!(paths.builtin_skills_dir().is_dir());
        assert!(paths.runtime_sessions_dir().is_dir());
    }

    #[test]
    fn data_dir_size_sums_nested_files() {
        let tmp = TempDir::new().unwrap();
        let paths = make_paths(&tmp);
        let base_size = paths.data_dir_size();

        std::fs::write(tmp.path().join("a.bin"), vec![0u8; 100]).unwrap();
        let nested = tmp.path().join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("b.bin"), vec![0u8; 50]).unwrap();

        assert_eq!(paths.data_dir_size(), base_size + 150);
    }

    #[test]
    fn dir_size_returns_zero_for_missing_dir() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(dir_size(&tmp.path().join("missing")), 0);
    }

    #[test]
    fn extract_bundled_claude_config_noop_without_bundle() {
        let data_tmp = TempDir::new().unwrap();
        let resource_tmp = TempDir::new().unwrap();
        let paths = make_paths(&data_tmp);

        paths.extract_bundled_claude_config(resource_tmp.path());
        assert!(!data_tmp.path().join(".claude").exists());
        assert!(!data_tmp.path().join("CLAUDE.md").exists());
    }

    #[test]
    fn extract_bundled_claude_config_copies_and_cleans_stale() {
        let data_tmp = TempDir::new().unwrap();
        let resource_tmp = TempDir::new().unwrap();
        let paths = make_paths(&data_tmp);

        // 构造 bundle：commands/ccbook + agents + CLAUDE.md
        let bundle = resource_tmp.path().join("resources").join("claude-bundle");
        let src_commands = bundle.join(".claude").join("commands").join("ccbook");
        let src_agents = bundle.join(".claude").join("agents");
        std::fs::create_dir_all(&src_commands).unwrap();
        std::fs::create_dir_all(&src_agents).unwrap();
        std::fs::write(src_commands.join("cmd.md"), "command").unwrap();
        std::fs::write(src_agents.join("agent.md"), "agent").unwrap();
        std::fs::write(bundle.join("CLAUDE.md"), "claude md").unwrap();

        // 预置旧版本残留文件，提取时应被清掉
        let dest_commands = data_tmp
            .path()
            .join(".claude")
            .join("commands")
            .join("ccbook");
        std::fs::create_dir_all(&dest_commands).unwrap();
        std::fs::write(dest_commands.join("stale.md"), "stale").unwrap();

        paths.extract_bundled_claude_config(resource_tmp.path());

        assert_eq!(
            std::fs::read_to_string(dest_commands.join("cmd.md")).unwrap(),
            "command"
        );
        assert!(!dest_commands.join("stale.md").exists(), "旧文件应被清理");
        assert_eq!(
            std::fs::read_to_string(
                data_tmp
                    .path()
                    .join(".claude")
                    .join("agents")
                    .join("agent.md")
            )
            .unwrap(),
            "agent"
        );
        assert_eq!(
            std::fs::read_to_string(data_tmp.path().join("CLAUDE.md")).unwrap(),
            "claude md"
        );
    }
}
