mod app_paths;
pub mod atomic_file;
pub mod claude_path;
pub mod command;
pub mod error;
pub mod error_codes;
pub mod git_command;
pub mod host_path;
pub mod launch_request;
pub mod orchestrator_manifest;
pub mod path_normalize;
pub mod path_validator;
pub mod project_identity;
pub mod text_encoding;

pub use app_paths::{AppPaths, APP_DIR_NAME};
pub use claude_path::{encode_claude_project_path, is_claude_project_match};
pub use command::{no_window_command, no_window_tokio_command};
pub use error::AppResult;
pub use git_command::{
    git_https_credential_env, output_with_timeout, output_with_timeout_limit,
    prepare_git_clone_auth, redact_git_url, GIT_CHECKOUT_TIMEOUT, GIT_LOCAL_TIMEOUT,
    GIT_MAX_OUTPUT_BYTES, GIT_NETWORK_TIMEOUT,
};
pub use host_path::{
    classify_launch_cwd_for_host, validate_launch_cwd, validate_spawn_cwd, HostPlatform,
    LaunchRuntime,
};
pub use launch_request::{
    normalize_session_request_for_current_host, normalize_session_request_for_host,
};
pub use path_normalize::{
    normalize_project_path, paths_equivalent, simplify_opt_path_str, simplify_path,
    simplify_path_str,
};
pub use path_validator::{
    sanitize_path_display, validate_command, validate_git_url, validate_mcp_name, validate_path,
    validate_relative_path, validate_ssh_info, validate_ssh_machine, validate_worktree_name,
};
pub use project_identity::{
    canonical_project_path, project_identity_key, project_paths_equivalent,
};
pub use text_encoding::decode_text_lossy_gbk;
