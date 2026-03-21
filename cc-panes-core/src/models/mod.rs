mod project;
mod terminal;
mod history;
mod workspace;
pub mod settings;
pub mod provider;
pub mod todo;
pub mod spec;
pub mod filesystem;
pub mod screenshot;
pub mod ssh_machine;
pub mod process_info;

pub use project::Project;
pub use terminal::{CliTool, CreateSessionRequest, ResizeRequest, TerminalExit, TerminalOutput};
pub use history::{
    FileVersion, VersionsMetadata, HistoryConfig, ProjectConfig,
    // Diff 模型
    DiffChangeType, InlineChange, DiffLine, DiffStats, DiffHunk, DiffResult,
    // 标签模型
    LabelFileSnapshot, HistoryLabel,
    // 最近更改
    RecentChange, WorktreeRecentChange,
};
pub use workspace::{Workspace, WorkspaceProject, ScannedRepo, ScannedWorktree, SshConnectionInfo};
pub use screenshot::ScreenshotResult;
pub use ssh_machine::{SshMachine, SshMachineConfig, AuthMethod};
pub use process_info::{ClaudeProcess, ClaudeProcessType, ProcessScanResult};
