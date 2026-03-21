mod app_paths;
pub mod claude_path;
pub mod error;
pub mod error_codes;
pub mod git_command;
pub mod path_validator;

pub use app_paths::{AppPaths, APP_DIR_NAME};
pub use claude_path::{encode_claude_project_path, is_claude_project_match};
pub use error::AppResult;
pub use git_command::{output_with_timeout, GIT_CHECKOUT_TIMEOUT, GIT_LOCAL_TIMEOUT, GIT_NETWORK_TIMEOUT};
pub use path_validator::{sanitize_path_display, validate_command, validate_git_url, validate_mcp_name, validate_path, validate_relative_path, validate_ssh_info, validate_ssh_machine, validate_worktree_name};
