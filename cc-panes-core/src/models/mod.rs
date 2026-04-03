pub mod filesystem;
mod history;
pub mod process_info;
mod project;
pub mod provider;
pub mod screenshot;
pub mod session_restore;
pub mod settings;
pub mod shared_mcp;
pub mod spec;
pub mod ssh_machine;
pub mod task_binding;
mod terminal;
pub mod todo;
mod workspace;
pub mod wsl;

pub use history::{
    // Diff 模型
    DiffChangeType,
    DiffHunk,
    DiffLine,
    DiffResult,
    DiffStats,
    FileVersion,
    HistoryConfig,
    HistoryLabel,
    InlineChange,
    // 标签模型
    LabelFileSnapshot,
    ProjectConfig,
    // 最近更改
    RecentChange,
    VersionsMetadata,
    WorktreeRecentChange,
};
pub use process_info::{ClaudeProcess, ClaudeProcessType, ProcessScanResult, ResourceStats};
pub use project::Project;
pub use screenshot::ScreenshotResult;
pub use ssh_machine::{AuthMethod, SshMachine, SshMachineConfig};
pub use terminal::{
    CliTool, CreateSessionRequest, ResizeRequest, TerminalBufferMode, TerminalExit, TerminalOutput,
    TerminalReplaySnapshot, WslLaunchInfo,
};
pub use workspace::{
    ProjectMigrationPlan, ProjectMigrationRequest, ProjectMigrationResult,
    ProjectMigrationRollbackResult, ScannedRepo, ScannedWorktree, SshConnectionInfo, Workspace,
    WorkspaceLaunchEnvironment, WorkspaceMigrationItem, WorkspaceMigrationPlan,
    WorkspaceMigrationRequest, WorkspaceMigrationResult, WorkspaceMigrationRollbackResult,
    WorkspaceMigrationStatus, WorkspaceMigrationTargetKind, WorkspaceProject,
    WorkspaceSshLaunchConfig, WorkspaceWslConfig,
};
pub use wsl::{WslDistro, WslDistroState};
