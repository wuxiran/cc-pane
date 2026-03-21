/// 将项目路径编码为 Claude CLI 使用的目录名。
///
/// 规则：冒号、斜杠、反斜杠、下划线均替换为连字符 `-`。
/// 例如：`D:\04_workspace_rust\vms` → `D--04-workspace-rust-vms`
pub fn encode_claude_project_path(path: &str) -> String {
    path.replace([':', '\\', '/', '_'], "-")
}

/// 检查目录名是否匹配项目路径（编码后比较）。
pub fn is_claude_project_match(dir_name: &str, project_path: &str) -> bool {
    dir_name == encode_claude_project_path(project_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_vms_workspace() {
        assert_eq!(
            encode_claude_project_path(r"I:\vms-workspace"),
            "I--vms-workspace"
        );
    }

    #[test]
    fn test_encode_vms_project() {
        assert_eq!(
            encode_claude_project_path(r"D:\04_workspace_rust\vms"),
            "D--04-workspace-rust-vms"
        );
    }

    #[test]
    fn test_encode_cc_book() {
        assert_eq!(
            encode_claude_project_path(r"D:\04_workspace_rust\cc-book"),
            "D--04-workspace-rust-cc-book"
        );
    }

    #[test]
    fn test_encode_unix_path() {
        assert_eq!(
            encode_claude_project_path("/home/user/my_project"),
            "-home-user-my-project"
        );
    }

    #[test]
    fn test_is_match_true() {
        assert!(is_claude_project_match(
            "D--04-workspace-rust-vms",
            r"D:\04_workspace_rust\vms"
        ));
    }

    #[test]
    fn test_is_match_false() {
        assert!(!is_claude_project_match(
            "D--04-workspace-rust-cc-book",
            r"D:\04_workspace_rust\vms"
        ));
    }
}
