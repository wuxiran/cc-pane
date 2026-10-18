use crate::utils::{canonical_project_path, project_identity_key};
use std::path::{Component, Path, PathBuf};

/// Extract the displayed suffix using the same canonical components as the
/// identity comparison. A case-insensitive prefix must not be stripped again
/// using a case-sensitive string operation.
pub(super) fn relative_project_path(project: &str, root: &str) -> Option<String> {
    if [project, root].iter().any(|path| {
        path.split(['/', '\\'])
            .any(|part| part == "." || part == "..")
    }) {
        // Treat a non-normalized registration as external rather than emitting
        // a suffix that could escape the destination root.
        return None;
    }
    let project_key = comparison_key(project);
    let root_key = comparison_key(root);
    if project_key == root_key {
        return Some(String::new());
    }
    if !project_key.starts_with(&(root_key + "/")) {
        return None;
    }
    let display_root = canonical_project_path(root).replace('\\', "/");
    let root_depth = display_root
        .split('/')
        .filter(|part| !part.is_empty())
        .count();
    Some(
        canonical_project_path(project)
            .replace('\\', "/")
            .split('/')
            .filter(|part| !part.is_empty())
            .skip(root_depth)
            .collect::<Vec<_>>()
            .join("/"),
    )
}

pub(super) fn comparison_key(path: &str) -> String {
    project_identity_key(path)
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// Resolve every existing ancestor before appending a missing suffix. Processing
/// `..` after resolving symlinks preserves the host's physical path semantics.
fn physical_path(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(name) => {
                resolved.push(name);
                match std::fs::symlink_metadata(&resolved) {
                    Ok(_) => resolved = resolved.canonicalize().map_err(|e| e.to_string())?,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    Ok(resolved)
}

pub(super) fn ensure_separate_target(source: &Path, target: &Path) -> Result<(), String> {
    let source = comparison_key(&physical_path(source)?.to_string_lossy());
    let target = comparison_key(&physical_path(target)?.to_string_lossy());
    if source == target {
        return Err("Migration target root cannot be the same as source root".to_string());
    }
    if target.starts_with(&(source + "/")) {
        return Err("Migration target root cannot be inside the source workspace".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_path_preserves_case_and_cross_form_suffixes() {
        for (project, root, expected) in [
            (r"c:\repo\Backend", r"C:\Repo", Some("Backend")),
            ("/mnt/c/repo/Äpp", r"C:\Repo", Some("Äpp")),
            (
                r"\\wsl.localhost\Ubuntu\home\user\repo",
                r"\\wsl.localhost\Ubuntu\home\User",
                None,
            ),
            ("/repo-other/app", "/repo", None),
            ("C:/Repo/../other", "C:/Repo", None),
            ("/repo/app", "/", Some("repo/app")),
            (r"c:\repo", r"C:\Repo", Some("")),
        ] {
            assert_eq!(relative_project_path(project, root).as_deref(), expected);
        }
    }

    #[test]
    fn target_guard_resolves_parent_components_and_missing_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let sibling = dir.path().join("sibling");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(ensure_separate_target(&source, &sibling.join("../source/new/deep")).is_err());
        assert!(ensure_separate_target(&source, &sibling.join("new")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn target_guard_resolves_symlink_ancestors() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let alias = dir.path().join("alias");
        std::fs::create_dir_all(&source).unwrap();
        std::os::unix::fs::symlink(&source, &alias).unwrap();
        assert!(ensure_separate_target(&source, &alias.join("new/deep")).is_err());
        assert!(ensure_separate_target(&source, &alias).is_err());
        assert!(!source.join("new").exists());
    }
}
