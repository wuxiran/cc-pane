//! Project identity normalization across Windows and WSL path representations.
//!
//! The pure string logic lives in the zero-dependency `cc-panes-paths` crate so that
//! `cc-cli-adapters` and `cc-panes-cli-hook` share the same rules. This module re-exports it
//! under the historical names and keeps the host-dependent persisted-path repair here.

use std::path::Path;

pub use cc_panes_paths::{
    canonical_project_path, identity_key as project_identity_key, project_paths_equivalent,
};

use super::HostPlatform;

/// Preserve the persisted path when it is usable on this host. If an older migration stored an
/// unusable cross-host form, repair it to an equivalent directory that is usable here.
pub fn repair_persisted_project_path(path: &str) -> String {
    repair_project_path_for_host_with(path, HostPlatform::current(), |candidate| {
        Path::new(candidate).is_dir()
    })
}

fn repair_project_path_for_host_with<F>(
    path: &str,
    host: HostPlatform,
    is_usable_directory: F,
) -> String
where
    F: Fn(&str) -> bool,
{
    if is_ssh_url(path) || is_usable_directory(path) {
        return path.to_string();
    }

    let canonical = canonical_project_path(path);
    let candidate = match host {
        HostPlatform::Windows => Some(canonical),
        // Only drive identities have a `/mnt` twin; WSL Linux UNC paths are left alone.
        HostPlatform::Unix => is_windows_drive_path(&canonical)
            .then(|| {
                cc_panes_paths::to_wsl_posix(&canonical, cc_panes_paths::DEFAULT_WSL_MOUNT_ROOT)
            })
            .flatten(),
    };
    candidate
        .filter(|candidate| candidate != path && is_usable_directory(candidate))
        .unwrap_or_else(|| path.to_string())
}

fn is_ssh_url(path: &str) -> bool {
    path.get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("ssh://"))
}

fn is_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_frontend_backend_identity_contract() {
        #[derive(serde::Deserialize)]
        struct Case {
            input: String,
            key: String,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../tests/fixtures/project_identity.json"))
                .unwrap();
        for case in cases {
            assert_eq!(
                project_identity_key(&case.input),
                case.key,
                "{}",
                case.input
            );
        }
    }

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
    fn persisted_path_repair_preserves_usable_unix_mnt_form() {
        let repaired = repair_project_path_for_host_with(
            "/mnt/d/Repos/App",
            super::super::HostPlatform::Unix,
            |path| path == "/mnt/d/Repos/App",
        );

        assert_eq!(repaired, "/mnt/d/Repos/App");
    }

    #[test]
    fn persisted_path_repair_recovers_unusable_cross_host_forms() {
        let unix = repair_project_path_for_host_with(
            r"D:\Repos\App",
            super::super::HostPlatform::Unix,
            |path| path == "/mnt/d/Repos/App",
        );
        let windows = repair_project_path_for_host_with(
            "/mnt/d/Repos/App",
            super::super::HostPlatform::Windows,
            |path| path == r"D:\Repos\App",
        );

        assert_eq!(unix, "/mnt/d/Repos/App");
        assert_eq!(windows, r"D:\Repos\App");
    }

    #[test]
    fn reexported_identity_key_keeps_historical_name() {
        assert_eq!(project_identity_key("/mnt/d/Repos/App"), r"d:\repos\app");
    }
}
