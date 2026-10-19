//! 项目身份：跨 Windows / WSL 表示形式判断"是不是同一个项目"。
//!
//! 通用路径比较（[`crate::paths_equivalent`]）刻意不把盘符路径与 WSL 挂载路径视为相等；
//! 项目注册需要这种跨运行时身份，才能让一条项目记录同时服务本地与 WSL 启动。

use crate::normalize::normalize_project_path;

/// 项目路径的规范表示（比较键的输入，**不能**替代展示或执行用的路径）。
///
/// 盘符路径、`/mnt/<drive>` 路径、指向挂载盘的 WSL UNC 路径统一为 `D:\...`；
/// 经 WSL UNC 暴露的 Linux 路径统一为 `\\wsl.localhost\<distro>\...`。
/// SSH URL 与普通 POSIX 路径保持原样。
pub fn canonical_project_path(path: &str) -> String {
    if is_ssh_url(path) {
        return path.to_string();
    }

    let normalized = normalize_project_path(path).to_string_lossy().into_owned();
    let slash_path = normalized.replace('\\', "/");

    if let Some(canonical) = canonical_windows_drive_path(&slash_path) {
        return canonical;
    }
    if let Some(canonical) = canonical_mnt_drive_path(&slash_path) {
        return canonical;
    }
    if let Some(canonical) = canonical_wsl_unc_path(&slash_path) {
        return canonical;
    }

    if slash_path.starts_with("//") {
        return slash_path.replace('/', "\\");
    }

    slash_path
}

/// 项目身份比较键。
///
/// 只有规范化后的盘符路径忽略 ASCII 大小写。WSL Linux 路径、distro 名、普通 UNC、
/// POSIX 路径与 SSH URL 保持大小写敏感。
pub fn identity_key(path: &str) -> String {
    let canonical = canonical_project_path(path);
    if is_windows_drive_path(&canonical) {
        canonical.to_ascii_lowercase()
    } else {
        canonical
    }
}

/// 按项目注册语义比较两个路径，包括安全的 Windows / WSL 跨形式映射。
pub fn project_paths_equivalent(a: &str, b: &str) -> bool {
    identity_key(a) == identity_key(b)
}

fn is_ssh_url(path: &str) -> bool {
    path.get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("ssh://"))
}

fn is_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn canonical_windows_drive_path(path: &str) -> Option<String> {
    if !is_windows_drive_path(path) {
        return None;
    }

    let drive = (path.as_bytes()[0] as char).to_ascii_uppercase();
    let rest = &path[2..];
    if rest.is_empty() {
        return Some(format!("{drive}:"));
    }
    if !rest.starts_with('/') {
        return None;
    }

    Some(format_drive_path(drive, rest.trim_start_matches('/')))
}

fn canonical_mnt_drive_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/mnt/")?;
    let bytes = rest.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return None;
    }
    if bytes.get(1).is_some_and(|byte| *byte != b'/') {
        return None;
    }

    let drive = (bytes[0] as char).to_ascii_uppercase();
    let tail = rest.get(1..).unwrap_or_default().trim_start_matches('/');
    Some(format_drive_path(drive, tail))
}

fn canonical_wsl_unc_path(path: &str) -> Option<String> {
    let without_prefix = path.strip_prefix("//")?;
    let mut parts = without_prefix.split('/');
    let server = parts.next()?;
    if !matches_wsl_server(server) {
        return None;
    }

    let distro = parts.next()?;
    if distro.is_empty() {
        return None;
    }

    let remote_parts: Vec<&str> = parts.filter(|part| !part.is_empty()).collect();
    if remote_parts.first() == Some(&"mnt") {
        if let Some(drive) = remote_parts
            .get(1)
            .and_then(|value| single_drive_letter(value))
        {
            let tail = remote_parts.get(2..).unwrap_or_default().join("/");
            return Some(format_drive_path(drive, &tail));
        }
    }

    let mut canonical = format!(r"\\wsl.localhost\{distro}");
    if !remote_parts.is_empty() {
        canonical.push('\\');
        canonical.push_str(&remote_parts.join("\\"));
    }
    Some(canonical)
}

fn matches_wsl_server(server: &str) -> bool {
    server.eq_ignore_ascii_case("wsl.localhost")
        || server.eq_ignore_ascii_case("wsl$")
        || server.eq_ignore_ascii_case("wsl")
}

fn single_drive_letter(value: &str) -> Option<char> {
    let bytes = value.as_bytes();
    (bytes.len() == 1 && bytes[0].is_ascii_alphabetic())
        .then(|| (bytes[0] as char).to_ascii_uppercase())
}

fn format_drive_path(drive: char, tail: &str) -> String {
    let tail = tail.trim_matches('/');
    if tail.is_empty() {
        format!(r"{drive}:\")
    } else {
        format!(r"{drive}:\{}", tail.replace('/', "\\"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_windows_drive_variants() {
        assert_eq!(canonical_project_path(r"d:\Repo\App\\"), r"D:\Repo\App");
        assert_eq!(canonical_project_path("d:/Repo/App/"), r"D:\Repo\App");
        assert_eq!(canonical_project_path(r"\\?\d:\Repo\App"), r"D:\Repo\App");
        assert_eq!(canonical_project_path(r"d:\"), r"D:\");
    }

    #[test]
    fn canonicalizes_mnt_and_wsl_unc_drive_paths() {
        let expected = r"D:\Repos\App";
        assert_eq!(canonical_project_path("/mnt/d/Repos/App/"), expected);
        assert_eq!(
            canonical_project_path(r"\\wsl.localhost\Ubuntu\mnt\d\Repos\App"),
            expected
        );
        assert_eq!(
            canonical_project_path(r"\\wsl$\Ubuntu-24.04\mnt\D\Repos\App\\"),
            expected
        );
        assert_eq!(canonical_project_path("/mnt/d"), r"D:\");
    }

    #[test]
    fn drive_identity_is_case_insensitive_across_all_forms() {
        let windows = r"D:\Repos\App";
        assert!(project_paths_equivalent(windows, "/mnt/d/repos/app/"));
        assert!(project_paths_equivalent(
            windows,
            r"\\wsl.localhost\Ubuntu\mnt\d\REPOS\APP"
        ));
        assert!(project_paths_equivalent(
            r"\\wsl$\Ubuntu\mnt\d\Repos\App",
            r"d:\repos\app"
        ));
    }

    #[test]
    fn canonicalizes_wsl_linux_unc_without_case_folding() {
        assert_eq!(
            canonical_project_path(r"\\wsl$\Ubuntu\home\User\Repo\\"),
            r"\\wsl.localhost\Ubuntu\home\User\Repo"
        );
        assert!(project_paths_equivalent(
            r"\\wsl$\Ubuntu\home\User\Repo",
            r"\\wsl.localhost\Ubuntu\home\User\Repo"
        ));
        assert!(!project_paths_equivalent(
            r"\\wsl.localhost\Ubuntu\home\User\Repo",
            r"\\wsl.localhost\Ubuntu\home\user\Repo"
        ));
        assert!(!project_paths_equivalent(
            r"\\wsl.localhost\Ubuntu\home\User\Repo",
            r"\\wsl.localhost\ubuntu\home\User\Repo"
        ));
    }

    #[test]
    fn keeps_unknown_unc_posix_and_ssh_case_sensitive() {
        assert!(project_paths_equivalent(
            r"\\server\share\Folder\\",
            "//server/share/Folder/"
        ));
        assert!(!project_paths_equivalent(
            r"\\server\share\Folder",
            r"\\server\share\folder"
        ));
        assert!(!project_paths_equivalent(
            "/home/User/Repo",
            "/home/user/Repo"
        ));

        let ssh = "ssh://dev@example.com/home/Repo/";
        assert_eq!(canonical_project_path(ssh), ssh);
        assert!(!project_paths_equivalent(
            ssh,
            "ssh://dev@example.com/home/repo/"
        ));
    }

    #[test]
    fn mid_path_mnt_is_not_a_drive() {
        assert_eq!(identity_key("/home/u/mnt/a/foo"), "/home/u/mnt/a/foo");
    }

    #[test]
    fn canonicalization_is_idempotent() {
        for path in [
            r"d:\Repos\App\\",
            "/mnt/d/Repos/App/",
            r"\\wsl$\Ubuntu\mnt\d\Repos\App",
            r"\\wsl$\Ubuntu\home\User\Repo\\",
            r"\\server\share\Folder\\",
            "ssh://dev@example.com/home/Repo/",
        ] {
            let once = canonical_project_path(path);
            assert_eq!(canonical_project_path(&once), once, "path: {path}");
        }
    }
}
