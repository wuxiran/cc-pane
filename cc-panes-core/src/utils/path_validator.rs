use std::collections::HashMap;
use std::path::Path;

use crate::utils::error::AppError;
use crate::utils::error_codes as EC;

/// 验证路径安全性，防止路径穿越攻击
///
/// 检查项：
/// 1. 路径不包含 `..` 分量
/// 2. 路径是绝对路径（或为空时跳过）
pub fn validate_path(path: &str) -> Result<(), AppError> {
    if path.is_empty() {
        return Err(AppError::coded(EC::PATH_EMPTY, "Path cannot be empty"));
    }

    let p = Path::new(path);

    // 检查路径穿越
    for component in p.components() {
        if let std::path::Component::ParentDir = component {
            return Err(AppError::coded_with_params(
                EC::PATH_TRAVERSAL,
                format!("Path contains illegal '..' component: {}", path),
                HashMap::from([("path".into(), path.into())]),
            ));
        }
    }

    // 要求绝对路径
    if !p.is_absolute() {
        return Err(AppError::coded_with_params(
            EC::PATH_NOT_ABSOLUTE,
            format!("Path must be absolute: {}", path),
            HashMap::from([("path".into(), path.into())]),
        ));
    }

    Ok(())
}

/// 验证文件路径相对于项目路径的安全性
///
/// 确保 file_path 不会穿越到 project_path 之外
pub fn validate_relative_path(project_path: &str, file_path: &str) -> Result<(), AppError> {
    validate_path(project_path)?;

    // file_path 是相对路径，检查不包含 ..
    if file_path.contains("..") {
        return Err(AppError::coded_with_params(
            EC::FILE_TRAVERSAL,
            format!("File path contains illegal '..' component: {}", file_path),
            HashMap::from([("path".into(), file_path.into())]),
        ));
    }

    Ok(())
}

/// 验证 Worktree 名称安全性
///
/// 拒绝包含路径穿越或路径分隔符的名称
pub fn validate_worktree_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() {
        return Err(AppError::coded(
            EC::WORKTREE_NAME_EMPTY,
            "Worktree name cannot be empty",
        ));
    }

    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(AppError::coded_with_params(
            EC::WORKTREE_NAME_INVALID,
            format!("Worktree name contains illegal characters: {}", name),
            HashMap::from([("name".into(), name.into())]),
        ));
    }

    // 拒绝纯空白名称
    if name.trim().is_empty() {
        return Err(AppError::coded(
            EC::WORKTREE_NAME_BLANK,
            "Worktree name cannot be blank",
        ));
    }

    Ok(())
}

/// 验证 Git URL 安全性
///
/// 只允许 HTTP/HTTPS 协议，防止 file:// 等危险协议
pub fn validate_git_url(url: &str) -> Result<(), AppError> {
    if url.is_empty() {
        return Err(AppError::coded(
            EC::GIT_URL_EMPTY,
            "Git URL cannot be empty",
        ));
    }

    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::coded_with_params(
            EC::GIT_URL_INVALID_PROTOCOL,
            format!("Only HTTP/HTTPS protocol Git URLs are supported: {}", url),
            HashMap::from([("url".into(), url.into())]),
        ));
    }

    // 防止命令注入字符
    if url.contains(';') || url.contains('|') || url.contains('`') || url.contains("$(") {
        return Err(AppError::coded(
            EC::GIT_URL_INVALID_CHARS,
            "Git URL contains illegal characters",
        ));
    }

    Ok(())
}

/// 验证 MCP Server 名称
pub fn validate_mcp_name(name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() {
        return Err(AppError::coded(
            EC::MCP_NAME_EMPTY,
            "MCP server name cannot be empty",
        ));
    }
    if name.len() > 128 {
        return Err(AppError::coded(
            EC::MCP_NAME_TOO_LONG,
            "MCP server name is too long (max 128 chars)",
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(AppError::coded_with_params(
            EC::MCP_NAME_INVALID,
            "MCP server name contains invalid characters",
            HashMap::from([("name".into(), name.into())]),
        ));
    }
    Ok(())
}

/// 验证命令名安全性
pub fn validate_command(command: &str) -> Result<(), AppError> {
    if command.trim().is_empty() {
        return Err(AppError::coded(
            EC::COMMAND_EMPTY,
            "Command cannot be empty",
        ));
    }
    if command.contains(';')
        || command.contains('|')
        || command.contains('`')
        || command.contains("$(")
    {
        return Err(AppError::coded_with_params(
            EC::COMMAND_INVALID_CHARS,
            "Command contains potentially dangerous characters",
            HashMap::from([("command".into(), command.into())]),
        ));
    }
    Ok(())
}

/// 验证 SSH 连接信息安全性
pub fn validate_ssh_info(info: &crate::models::SshConnectionInfo) -> Result<(), AppError> {
    // 危险字符集（命令注入防护）
    const DANGEROUS_CHARS: &[char] = &[';', '|', '`', '$', '&', '\n', '\r', '\'', '"', '\\'];

    // host 非空
    if info.host.trim().is_empty() {
        return Err(AppError::coded(
            EC::SSH_HOST_EMPTY,
            "SSH host cannot be empty",
        ));
    }

    // host 无危险字符
    if info.host.chars().any(|c| DANGEROUS_CHARS.contains(&c)) {
        return Err(AppError::coded_with_params(
            EC::SSH_INVALID_CHARS,
            format!("SSH host contains illegal characters: {}", info.host),
            HashMap::from([("field".into(), "host".into())]),
        ));
    }

    // remote_path 非空
    if info.remote_path.trim().is_empty() {
        return Err(AppError::coded(
            EC::SSH_REMOTE_PATH_EMPTY,
            "SSH remote path cannot be empty",
        ));
    }

    // remote_path 必须以 / 或 ~ 开头（绝对路径或 home 目录）
    if !info.remote_path.starts_with('/') && !info.remote_path.starts_with('~') {
        return Err(AppError::coded_with_params(
            EC::SSH_REMOTE_PATH_NOT_ABSOLUTE,
            format!(
                "SSH remote path must be absolute (start with /): {}",
                info.remote_path
            ),
            HashMap::from([("path".into(), info.remote_path.clone())]),
        ));
    }

    // remote_path 无危险字符（允许单引号在 shell_escape 中处理，但其他字符拒绝）
    const PATH_DANGEROUS: &[char] = &[';', '|', '`', '$', '&', '\n', '\r', '"', '(', ')'];
    if info
        .remote_path
        .chars()
        .any(|c| PATH_DANGEROUS.contains(&c))
    {
        return Err(AppError::coded_with_params(
            EC::SSH_INVALID_CHARS,
            format!(
                "SSH remote path contains illegal characters: {}",
                info.remote_path
            ),
            HashMap::from([("field".into(), "remotePath".into())]),
        ));
    }

    // user（可选）验证
    if let Some(ref user) = info.user {
        if user.chars().any(|c| DANGEROUS_CHARS.contains(&c)) {
            return Err(AppError::coded_with_params(
                EC::SSH_INVALID_CHARS,
                format!("SSH user contains illegal characters: {}", user),
                HashMap::from([("field".into(), "user".into())]),
            ));
        }
    }

    // port > 0（u16 已保证 >= 0，检查非零）
    if info.port == 0 {
        return Err(AppError::coded(
            EC::SSH_PORT_INVALID,
            "SSH port must be > 0",
        ));
    }

    // identity_file（可选）验证
    if let Some(ref identity_file) = info.identity_file {
        let trimmed = identity_file.trim();
        if trimmed.is_empty() {
            return Err(AppError::coded(
                EC::SSH_IDENTITY_FILE_INVALID,
                "SSH identity file path cannot be empty",
            ));
        }
        if trimmed.chars().any(|c| DANGEROUS_CHARS.contains(&c)) {
            return Err(AppError::coded_with_params(
                EC::SSH_IDENTITY_FILE_INVALID,
                format!("SSH identity file contains illegal characters: {}", trimmed),
                HashMap::from([("field".into(), "identityFile".into())]),
            ));
        }
        if trimmed.contains("..") {
            return Err(AppError::coded_with_params(
                EC::SSH_IDENTITY_FILE_INVALID,
                format!("SSH identity file contains path traversal: {}", trimmed),
                HashMap::from([("field".into(), "identityFile".into())]),
            ));
        }
    }

    Ok(())
}

/// 验证 SSH Machine 输入安全性（add/update 命令前置校验）
pub fn validate_ssh_machine(
    machine: &crate::models::ssh_machine::SshMachine,
) -> Result<(), AppError> {
    const DANGEROUS_CHARS: &[char] = &[';', '|', '&', '`', '\n', '\r'];

    // name 非空
    if machine.name.trim().is_empty() {
        return Err(AppError::coded(
            EC::SSH_NAME_EMPTY,
            "SSH machine name cannot be empty",
        ));
    }

    // host 非空
    if machine.host.trim().is_empty() {
        return Err(AppError::coded(
            EC::SSH_HOST_EMPTY,
            "SSH machine host cannot be empty",
        ));
    }

    // host 无危险字符
    if machine.host.chars().any(|c| DANGEROUS_CHARS.contains(&c)) || machine.host.contains("$(") {
        return Err(AppError::coded_with_params(
            EC::SSH_INVALID_CHARS,
            format!("SSH host contains illegal characters: {}", machine.host),
            HashMap::from([("field".into(), "host".into())]),
        ));
    }

    // port 范围 1-65535（u16 已保证 <= 65535，只需检查非零）
    if machine.port == 0 {
        return Err(AppError::coded(
            EC::SSH_PORT_INVALID,
            "SSH port must be between 1 and 65535",
        ));
    }

    // user（可选）无危险字符
    if let Some(ref user) = machine.user {
        if user.chars().any(|c| DANGEROUS_CHARS.contains(&c)) || user.contains("$(") {
            return Err(AppError::coded_with_params(
                EC::SSH_INVALID_CHARS,
                format!("SSH user contains illegal characters: {}", user),
                HashMap::from([("field".into(), "user".into())]),
            ));
        }
    }

    // identity_file（可选）无危险字符
    if let Some(ref identity_file) = machine.identity_file {
        let trimmed = identity_file.trim();
        if !trimmed.is_empty()
            && (trimmed.chars().any(|c| DANGEROUS_CHARS.contains(&c)) || trimmed.contains("$("))
        {
            return Err(AppError::coded_with_params(
                EC::SSH_IDENTITY_FILE_INVALID,
                format!("SSH identity file contains illegal characters: {}", trimmed),
                HashMap::from([("field".into(), "identityFile".into())]),
            ));
        }
    }

    Ok(())
}

/// 脱敏路径，仅保留文件名用于错误消息展示
///
/// 避免在面向用户的错误消息中暴露完整的文件系统路径。
/// 如果无法提取文件名，返回 `"<unknown>"`。
pub fn sanitize_path_display(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "<unknown>".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_absolute_path() {
        #[cfg(windows)]
        assert!(validate_path(r"C:\Users\test\project").is_ok());

        #[cfg(not(windows))]
        assert!(validate_path("/home/user/project").is_ok());
    }

    #[test]
    fn test_path_traversal_rejected() {
        #[cfg(windows)]
        assert!(validate_path(r"C:\Users\test\..\secret").is_err());

        #[cfg(not(windows))]
        assert!(validate_path("/home/user/../secret").is_err());
    }

    #[test]
    fn test_relative_path_rejected() {
        assert!(validate_path("relative/path").is_err());
    }

    #[test]
    fn test_empty_path_rejected() {
        assert!(validate_path("").is_err());
    }

    #[test]
    fn test_valid_relative_file_path() {
        #[cfg(windows)]
        assert!(validate_relative_path(r"C:\project", "src/main.rs").is_ok());

        #[cfg(not(windows))]
        assert!(validate_relative_path("/project", "src/main.rs").is_ok());
    }

    #[test]
    fn test_relative_file_path_traversal_rejected() {
        #[cfg(windows)]
        assert!(validate_relative_path(r"C:\project", "../secret.txt").is_err());

        #[cfg(not(windows))]
        assert!(validate_relative_path("/project", "../secret.txt").is_err());
    }

    #[test]
    fn test_valid_git_url() {
        assert!(validate_git_url("https://github.com/user/repo.git").is_ok());
        assert!(validate_git_url("http://gitlab.com/user/repo").is_ok());
    }

    #[test]
    fn test_git_url_rejects_file_protocol() {
        assert!(validate_git_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn test_git_url_rejects_ssh_protocol() {
        assert!(validate_git_url("ssh://git@github.com/user/repo.git").is_err());
    }

    #[test]
    fn test_git_url_rejects_injection_chars() {
        assert!(validate_git_url("https://example.com/repo;rm -rf /").is_err());
        assert!(validate_git_url("https://example.com/repo|cat /etc/passwd").is_err());
        assert!(validate_git_url("https://example.com/repo`whoami`").is_err());
        assert!(validate_git_url("https://example.com/$(id)").is_err());
    }

    #[test]
    fn test_git_url_rejects_empty() {
        assert!(validate_git_url("").is_err());
    }

    #[test]
    fn test_valid_worktree_name() {
        assert!(validate_worktree_name("feature-auth").is_ok());
        assert!(validate_worktree_name("hotfix-123").is_ok());
        assert!(validate_worktree_name("my_branch").is_ok());
    }

    #[test]
    fn test_worktree_name_rejects_traversal() {
        assert!(validate_worktree_name("..").is_err());
        assert!(validate_worktree_name("../secret").is_err());
        assert!(validate_worktree_name("foo/../bar").is_err());
    }

    #[test]
    fn test_worktree_name_rejects_path_separators() {
        assert!(validate_worktree_name("foo/bar").is_err());
        assert!(validate_worktree_name("foo\\bar").is_err());
    }

    #[test]
    fn test_worktree_name_rejects_empty() {
        assert!(validate_worktree_name("").is_err());
        assert!(validate_worktree_name("  ").is_err());
    }

    #[test]
    fn test_sanitize_path_display_full_path() {
        let path = Path::new("/home/user/.cc-panes/config.toml");
        assert_eq!(sanitize_path_display(path), "config.toml");
    }

    #[test]
    fn test_sanitize_path_display_windows_path() {
        let path = Path::new(r"C:\Users\test\.cc-panes\providers.json");
        assert_eq!(sanitize_path_display(path), "providers.json");
    }

    #[test]
    fn test_sanitize_path_display_filename_only() {
        let path = Path::new("data.db");
        assert_eq!(sanitize_path_display(path), "data.db");
    }

    #[test]
    fn test_valid_ssh_info() {
        use crate::models::SshConnectionInfo;
        let info = SshConnectionInfo {
            host: "my-server".to_string(),
            port: 22,
            user: Some("deploy".to_string()),
            remote_path: "/home/deploy/project".to_string(),
            identity_file: None,
        };
        assert!(validate_ssh_info(&info).is_ok());
    }

    #[test]
    fn test_ssh_rejects_empty_host() {
        use crate::models::SshConnectionInfo;
        let info = SshConnectionInfo {
            host: "".to_string(),
            port: 22,
            user: None,
            remote_path: "/tmp".to_string(),
            identity_file: None,
        };
        assert!(validate_ssh_info(&info).is_err());
    }

    #[test]
    fn test_ssh_rejects_relative_path() {
        use crate::models::SshConnectionInfo;
        let info = SshConnectionInfo {
            host: "server".to_string(),
            port: 22,
            user: None,
            remote_path: "relative/path".to_string(),
            identity_file: None,
        };
        assert!(validate_ssh_info(&info).is_err());
    }

    #[test]
    fn test_ssh_rejects_injection_chars() {
        use crate::models::SshConnectionInfo;
        let info = SshConnectionInfo {
            host: "server;rm -rf /".to_string(),
            port: 22,
            user: None,
            remote_path: "/tmp".to_string(),
            identity_file: None,
        };
        assert!(validate_ssh_info(&info).is_err());
    }

    #[test]
    fn test_ssh_rejects_identity_file_with_dangerous_chars() {
        use crate::models::SshConnectionInfo;
        let info = SshConnectionInfo {
            host: "server".to_string(),
            port: 22,
            user: None,
            remote_path: "/tmp".to_string(),
            identity_file: Some("/home/user/.ssh/id;rm -rf /".to_string()),
        };
        assert!(validate_ssh_info(&info).is_err());
    }

    #[test]
    fn test_ssh_rejects_identity_file_traversal() {
        use crate::models::SshConnectionInfo;
        let info = SshConnectionInfo {
            host: "server".to_string(),
            port: 22,
            user: None,
            remote_path: "/tmp".to_string(),
            identity_file: Some("/home/user/../../../etc/shadow".to_string()),
        };
        assert!(validate_ssh_info(&info).is_err());
    }

    #[test]
    fn test_ssh_accepts_valid_identity_file() {
        use crate::models::SshConnectionInfo;
        let info = SshConnectionInfo {
            host: "server".to_string(),
            port: 22,
            user: None,
            remote_path: "/tmp".to_string(),
            identity_file: Some("~/.ssh/id_rsa".to_string()),
        };
        assert!(validate_ssh_info(&info).is_ok());
    }

    #[test]
    fn test_ssh_rejects_remote_path_with_parentheses() {
        use crate::models::SshConnectionInfo;
        let info = SshConnectionInfo {
            host: "server".to_string(),
            port: 22,
            user: None,
            remote_path: "/tmp/$(whoami)".to_string(),
            identity_file: None,
        };
        assert!(validate_ssh_info(&info).is_err());
    }

    #[test]
    fn test_ssh_rejects_zero_port() {
        use crate::models::SshConnectionInfo;
        let info = SshConnectionInfo {
            host: "server".to_string(),
            port: 0,
            user: None,
            remote_path: "/tmp".to_string(),
            identity_file: None,
        };
        assert!(validate_ssh_info(&info).is_err());
    }
}
