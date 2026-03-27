pub mod filesystem;
mod history;
pub mod process_info;
mod project;
pub mod provider;
pub mod screenshot;
pub mod settings;
pub mod shared_mcp;
pub mod spec;
pub mod ssh_machine;
mod terminal;
pub mod todo;
mod workspace;

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
pub use terminal::{CliTool, CreateSessionRequest, ResizeRequest, TerminalExit, TerminalOutput};
pub use workspace::{ScannedRepo, ScannedWorktree, SshConnectionInfo, Workspace, WorkspaceProject};
