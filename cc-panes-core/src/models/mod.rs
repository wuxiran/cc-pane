pub mod external_skill;
pub mod filesystem;
mod history;
pub mod launch_profile;
pub mod plan;
pub mod process_info;
mod project;
pub mod provider;
pub mod runner;
pub mod screenshot;
pub mod session_restore;
pub mod settings;
pub mod shared_mcp;
pub mod spec;
pub mod ssh_machine;
pub mod task_binding;
mod terminal;
pub mod todo;
pub mod usage_stats;
mod workspace;
pub mod workspace_snapshot;
pub mod wsl;

pub use external_skill::{DiscoveredExternalSkill, ExternalSkillSource};
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
pub use launch_profile::{
    LaunchProfile, LaunchProfileConfig, LaunchProfileDraft, LaunchProfileMcpMode,
    LaunchProfileMcpPolicy, LaunchProfilePreviewRequest, LaunchProfileResolution,
    LaunchProfileSkillMode, LaunchProfileSkillPolicy, LaunchProviderSelection, ResolvedMcpServer,
    ResolvedSkill, SharedMcpUrls,
};
pub use process_info::{ClaudeProcess, ClaudeProcessType, ProcessScanResult, ResourceStats};
pub use project::Project;
pub use runner::{
    PortClaim, PortConflict, PortReservation, RunnerInstance, RunnerInstanceStatus,
    RunnerLaunchPlan, RunnerLaunchSuggestedAction, RunnerProfile, RunnerProfileDraft,
    RunnerStartResult, RunnerStartStatus,
};
pub use screenshot::ScreenshotResult;
pub use session_restore::SavedSession;
pub use ssh_machine::{AuthMethod, SshMachine, SshMachineConfig, SshMachineUpsertRequest};
pub use terminal::{
    CliTool, CreateSessionRequest, ResizeRequest, TerminalBufferMode, TerminalExit, TerminalOutput,
    TerminalReplaySnapshot, WslLaunchInfo,
};
pub use usage_stats::{
    UsageDayPoint, UsageEntry, UsageQueryResult, UsageScanState, UsageStatsDelta, UsageStatsRow,
    UsageTotals,
};
pub use workspace::{
    ProjectMigrationPlan, ProjectMigrationRequest, ProjectMigrationResult,
    ProjectMigrationRollbackResult, ScannedRepo, ScannedWorktree, SshConnectionInfo, Workspace,
    WorkspaceCliEnvironmentDefaults, WorkspaceLaunchEnvironment, WorkspaceMigrationItem,
    WorkspaceMigrationPlan, WorkspaceMigrationRequest, WorkspaceMigrationResult,
    WorkspaceMigrationRollbackResult, WorkspaceMigrationStatus, WorkspaceMigrationTargetKind,
    WorkspaceProject, WorkspaceSshLaunchConfig, WorkspaceWslConfig,
};
pub use workspace_snapshot::{WorkspaceSnapshot, WorkspaceSnapshotEntry};
pub use wsl::{WslDistro, WslDistroState};
