//! Project identity normalization across Windows and WSL path representations.
//!
//! This module deliberately sits above `path_normalize`: generic path comparison must not
//! equate a Windows drive path with a WSL mount. Project registration, however, needs that
//! cross-runtime identity so one project record can serve local and WSL launches.

use super::normalize_project_path;

/// Return the canonical stored representation for a project path.
///
/// Windows drive paths, `/mnt/<drive>` paths, and WSL UNC paths pointing at a mounted Windows
/// drive converge on `D:\\...`. Linux paths exposed through WSL UNC converge on
/// `\\\\wsl.localhost\\<distro>\\...`. SSH URLs and ordinary POSIX paths are preserved.
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

/// Return the stable comparison key for a registered project.
///
/// Only canonical Windows drive paths are ASCII case-insensitive. WSL Linux paths, distro
/// names, ordinary UNC paths, POSIX paths, and SSH URLs remain case-sensitive.
pub fn project_identity_key(path: &str) -> String {
    let canonical = canonical_project_path(path);
    if is_windows_drive_path(&canonical) {
        canonical.to_ascii_lowercase()
    } else {
        canonical
    }
}

/// Compare two paths as project registrations, including safe Windows/WSL cross-form mapping.
pub fn project_paths_equivalent(a: &str, b: &str) -> bool {
    project_identity_key(a) == project_identity_key(b)
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
