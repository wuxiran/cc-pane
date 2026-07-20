use crate::models::settings::WallpaperSettings;
use crate::models::ssh_machine::AuthMethod;
use serde::{Deserialize, Serialize};

/// 工作空间默认运行环境
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceLaunchEnvironment {
    #[default]
    Local,
    Wsl,
    Ssh,
}

/// 工作空间级 CLI 默认运行环境
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCliEnvironmentDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<WorkspaceLaunchEnvironment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<WorkspaceLaunchEnvironment>,
}

impl WorkspaceCliEnvironmentDefaults {
    pub fn get(&self, cli_tool: &str) -> Option<WorkspaceLaunchEnvironment> {
        match cli_tool {
            "claude" => self.claude,
            "codex" => self.codex,
            _ => None,
        }
    }
}

/// 工作空间级 WSL 启动配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWslConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_path: Option<String>,
}

/// 工作空间级 SSH 启动配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSshLaunchConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_path: Option<String>,
}

/// 工作空间中的项目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub path: String,
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl_remote_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConnectionInfo>,
}

/// 工作空间
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub alias: Option<String>,
    pub created_at: String,
    pub projects: Vec<WorkspaceProject>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub launch_profile_id: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub default_environment: WorkspaceLaunchEnvironment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_environment_defaults: Option<WorkspaceCliEnvironmentDefaults>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl: Option<WorkspaceWslConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_launch: Option<WorkspaceSshLaunchConfig>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub sort_order: Option<i32>,
    /// 默认工作空间：启动时缺失自动创建，列表恒置顶，不可删除
    #[serde(default)]
    pub is_default: bool,
    /// 工作空间壁纸覆盖：inherit 用全局 / custom 逐字段覆盖 / off 明确关闭全局壁纸。
    /// 放 workspace.json（壁纸属工作空间视觉身份，随迁移/分享走）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wallpaper_override: Option<WorkspaceWallpaperOverride>,
}

/// 工作空间级壁纸覆盖
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWallpaperOverride {
    /// "inherit" | "custom" | "off" —— off 必须与 inherit 区分：
    /// 用户要能在某个工作空间明确关掉全局壁纸。
    #[serde(default = "default_wallpaper_override_mode")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<WallpaperSettings>,
}

fn default_wallpaper_override_mode() -> String {
    "inherit".to_string()
}

/// 工作空间迁移目标类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMigrationTargetKind {
    Local,
    Wsl,
    Ssh,
}

/// 工作空间迁移请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMigrationRequest {
    pub workspace_name: String,
    pub target_kind: WorkspaceMigrationTargetKind,
    pub target_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_distro: Option<String>,
}

/// 迁移计划中的单个项目映射
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMigrationItem {
    pub project_id: String,
    pub project_name: String,
    pub source_path: String,
    pub destination_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub external: bool,
}

/// 工作空间迁移预览结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMigrationPlan {
    pub workspace_name: String,
    pub source_root: String,
    pub root_destination: String,
    pub target_kind: WorkspaceMigrationTargetKind,
    pub target_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_distro: Option<String>,
    pub items: Vec<WorkspaceMigrationItem>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// 迁移执行状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMigrationStatus {
    Succeeded,
    RolledBack,
}

/// 工作空间迁移执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMigrationResult {
    pub status: WorkspaceMigrationStatus,
    pub snapshot_id: String,
    pub workspace: Workspace,
    pub plan: WorkspaceMigrationPlan,
    pub copied_files: u64,
    pub copied_bytes: u64,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// 工作空间迁移回滚结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMigrationRollbackResult {
    pub snapshot_id: String,
    pub workspace: Workspace,
}

/// 项目迁移请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMigrationRequest {
    pub workspace_name: String,
    pub project_id: String,
    pub target_kind: WorkspaceMigrationTargetKind,
    pub target_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_distro: Option<String>,
}

/// 项目迁移预览结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMigrationPlan {
    pub workspace_name: String,
    pub project_id: String,
    pub project_name: String,
    pub source_path: String,
    pub destination_path: String,
    pub target_kind: WorkspaceMigrationTargetKind,
    pub target_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_distro: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// 项目迁移执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMigrationResult {
    pub status: WorkspaceMigrationStatus,
    pub snapshot_id: String,
    pub workspace: Workspace,
    pub plan: ProjectMigrationPlan,
    pub copied_files: u64,
    pub copied_bytes: u64,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// 项目迁移回滚结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMigrationRollbackResult {
    pub snapshot_id: String,
    pub workspace: Workspace,
}

impl Workspace {
    pub fn new(name: String, path: Option<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            alias: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            projects: Vec::new(),
            provider_id: None,
            launch_profile_id: None,
            path,
            default_environment: WorkspaceLaunchEnvironment::Local,
            cli_environment_defaults: None,
            wsl: None,
            ssh_launch: None,
            pinned: false,
            hidden: false,
            sort_order: None,
            is_default: false,
            wallpaper_override: None,
        }
    }
}

impl WorkspaceProject {
    pub fn new(path: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            path,
            alias: None,
            launch_profile_id: None,
            wsl_remote_path: None,
            ssh: None,
        }
    }
}

/// 扫描发现的 worktree 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedWorktree {
    pub path: String,
    pub branch: String,
}

/// 扫描发现的仓库信息（按主仓库分组）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedRepo {
    pub main_path: String,
    pub main_branch: String,
    pub worktrees: Vec<ScannedWorktree>,
}

fn default_ssh_port() -> u16 {
    22
}

/// SSH 连接信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionInfo {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub remote_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<AuthMethod>,
}

#[cfg(test)]
mod tests {
    use super::{Workspace, WorkspaceCliEnvironmentDefaults, WorkspaceLaunchEnvironment};

    #[test]
    fn deserialize_workspace_uses_local_environment_by_default() {
        let json = r#"{
            "id": "ws-1",
            "name": "workspace-1",
            "createdAt": "2026-04-02T00:00:00Z",
            "projects": []
        }"#;

        let workspace: Workspace =
            serde_json::from_str(json).expect("workspace should deserialize");
        assert_eq!(
            workspace.default_environment,
            WorkspaceLaunchEnvironment::Local
        );
        assert!(workspace.cli_environment_defaults.is_none());
        assert!(workspace.wsl.is_none());
        assert!(workspace.ssh_launch.is_none());
    }

    #[test]
    fn deserialize_workspace_partial_cli_environment_defaults() {
        let json = r#"{
            "id": "ws-1",
            "name": "workspace-1",
            "createdAt": "2026-04-02T00:00:00Z",
            "projects": [],
            "cliEnvironmentDefaults": {
                "codex": "wsl"
            }
        }"#;

        let workspace: Workspace =
            serde_json::from_str(json).expect("workspace should deserialize");
        let defaults = workspace
            .cli_environment_defaults
            .expect("cli defaults should deserialize");
        assert_eq!(defaults.claude, None);
        assert_eq!(defaults.codex, Some(WorkspaceLaunchEnvironment::Wsl));
    }

    #[test]
    fn serialize_workspace_skips_empty_cli_environment_defaults() {
        let workspace = Workspace::new("workspace-1".to_string(), None);

        let value = serde_json::to_value(&workspace).expect("serialize workspace");

        assert!(value.get("cliEnvironmentDefaults").is_none());
    }

    #[test]
    fn serialize_workspace_skips_empty_cli_entries() {
        let mut workspace = Workspace::new("workspace-1".to_string(), None);
        workspace.cli_environment_defaults = Some(WorkspaceCliEnvironmentDefaults {
            claude: Some(WorkspaceLaunchEnvironment::Wsl),
            codex: None,
        });

        let value = serde_json::to_value(&workspace).expect("serialize workspace");

        assert_eq!(value["cliEnvironmentDefaults"]["claude"], "wsl");
        assert!(value["cliEnvironmentDefaults"].get("codex").is_none());
    }
}
