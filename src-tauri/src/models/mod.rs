mod project;
mod terminal;
mod history;
mod workspace;
pub mod settings;
pub mod provider;
pub mod todo;
pub mod filesystem;
pub mod screenshot;

pub use project::Project;
pub use terminal::{CreateSessionRequest, ResizeRequest, TerminalExit, TerminalOutput};
pub use history::{
    FileVersion, VersionsMetadata, HistoryConfig, ProjectConfig,
    // Diff 模型
    DiffChangeType, InlineChange, DiffLine, DiffStats, DiffHunk, DiffResult,
    // 标签模型
    LabelFileSnapshot, HistoryLabel,
    // 最近更改
    RecentChange, WorktreeRecentChange,
};
pub use workspace::{Workspace, WorkspaceProject, ScannedRepo, ScannedWorktree};
pub use screenshot::{MonitorInfo, ScreenshotResult, TempScreenshot};
