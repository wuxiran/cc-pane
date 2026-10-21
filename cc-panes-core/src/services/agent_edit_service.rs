//! Conditional undo of one complete text edit reported by an agent.
use crate::models::SnapshotFile;
use crate::utils::{AppError, AppResult};
use std::path::{Component, Path};

pub const MAX_AGENT_EDIT_BYTES: usize = 1024 * 1024;

/// Restore only when the current file still matches the agent's entire output.
/// `None` means the agent explicitly reported that the file did not exist before.
/// The rooted publisher refuses symlinks and rechecks the file before replacing it.
pub fn undo_agent_text_edit(
    root: &Path,
    path: &str,
    before: Option<&str>,
    after: &str,
) -> AppResult<()> {
    validate_text(before, after)?;
    let canonical_root = dunce::canonicalize(root)?;
    let relative = relative_path(root, &canonical_root, path)?;
    let target = canonical_root.join(&relative);
    let metadata = std::fs::symlink_metadata(&target)?;
    if !metadata.is_file() || metadata.len() != after.len() as u64 {
        return Err(changed());
    }
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            "100644"
        } else {
            "100755"
        }
    };
    #[cfg(not(unix))]
    let mode = "100644";
    let file = |text: &str| SnapshotFile {
        bytes: text.as_bytes().to_vec(),
        mode: mode.into(),
    };
    super::fork_review_service::publish::publish(
        &canonical_root,
        &[(relative, Some(file(after)), before.map(file))],
    )
    .map_err(|error| {
        AppError::coded(
            "ACP_EDIT_CHANGED",
            format!("Cannot safely undo this edit: {error}"),
        )
    })?;
    Ok(())
}

fn validate_text(before: Option<&str>, after: &str) -> AppResult<()> {
    if before.is_some_and(|text| text.len() > MAX_AGENT_EDIT_BYTES)
        || after.len() > MAX_AGENT_EDIT_BYTES
        || before.is_some_and(|text| text.contains('\0'))
        || after.contains('\0')
        || before == Some(after)
    {
        return Err(AppError::coded(
            "ACP_EDIT_UNSUPPORTED",
            "Undo requires a complete changed text file of at most 1 MiB",
        ));
    }
    Ok(())
}

fn relative_path(root: &Path, canonical_root: &Path, raw: &str) -> AppResult<String> {
    let path = Path::new(raw);
    if raw.is_empty()
        || raw.contains('\0')
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(AppError::coded(
            "ACP_EDIT_PATH",
            "Edit path must stay inside this chat's working directory",
        ));
    }
    let relative = if path.is_absolute() {
        path.strip_prefix(root)
            .or_else(|_| path.strip_prefix(canonical_root))
            .map_err(|_| {
                AppError::coded(
                    "ACP_EDIT_PATH",
                    "Edit is outside this chat's working directory",
                )
            })?
    } else {
        path
    };
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::coded("ACP_EDIT_PATH", "Invalid edit path"));
    }
    relative
        .to_str()
        .map(|path| path.replace(std::path::MAIN_SEPARATOR, "/"))
        .ok_or_else(|| AppError::coded("ACP_EDIT_PATH", "Edit path must be valid UTF-8"))
}

fn changed() -> AppError {
    AppError::coded(
        "ACP_EDIT_CHANGED",
        "The file changed after this edit; its current contents were preserved",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn restores_only_the_matching_edit_and_retains_later_changes() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("example.txt");
        fs::write(&file, "after").unwrap();
        undo_agent_text_edit(root.path(), "example.txt", Some("before"), "after").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "before");
        fs::write(&file, "later").unwrap();
        assert!(undo_agent_text_edit(root.path(), "example.txt", Some("before"), "after").is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "later");
    }

    #[test]
    fn rejects_escape_missing_file_and_oversized_content() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let outside = other.path().join("outside.txt");
        fs::write(&outside, "after").unwrap();
        for path in [
            outside.to_str().unwrap(),
            "../outside.txt",
            ".git/config",
            "missing",
        ] {
            assert!(undo_agent_text_edit(root.path(), path, Some("before"), "after").is_err());
        }
        assert!(undo_agent_text_edit(
            root.path(),
            "x",
            Some(&"x".repeat(MAX_AGENT_EDIT_BYTES + 1)),
            "after"
        )
        .is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "after");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_leaf_and_parent_symlinks_and_preserves_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let outside = other.path().join("outside.txt");
        fs::write(&outside, "after").unwrap();
        symlink(&outside, root.path().join("link")).unwrap();
        symlink(other.path(), root.path().join("dir")).unwrap();
        for path in ["link", "dir/outside.txt"] {
            assert!(undo_agent_text_edit(root.path(), path, Some("before"), "after").is_err());
            assert!(undo_agent_text_edit(root.path(), path, None, "after").is_err());
        }
        assert_eq!(fs::read_to_string(outside).unwrap(), "after");
        let file = root.path().join("script");
        fs::write(&file, "after").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
        undo_agent_text_edit(root.path(), "script", Some("before"), "after").unwrap();
        assert_eq!(
            fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn new_file_undo_removes_only_the_matching_file_and_preserves_later_edits() {
        let root = tempfile::tempdir().unwrap();
        let created = root.path().join("created.txt");
        let unrelated = root.path().join("unrelated.txt");
        fs::write(&created, "after").unwrap();
        fs::write(&unrelated, "after").unwrap();
        undo_agent_text_edit(root.path(), "created.txt", None, "after").unwrap();
        assert!(!created.exists());
        assert_eq!(fs::read_to_string(&unrelated).unwrap(), "after");
        fs::write(&created, "later").unwrap();
        assert!(undo_agent_text_edit(root.path(), "created.txt", None, "after").is_err());
        assert_eq!(fs::read_to_string(&created).unwrap(), "later");
        assert_eq!(fs::read_to_string(&unrelated).unwrap(), "after");
    }

    #[test]
    fn empty_original_and_nonexistent_original_are_distinct() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("file.txt");
        fs::write(&file, "after").unwrap();
        undo_agent_text_edit(root.path(), "file.txt", Some(""), "after").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "");
        undo_agent_text_edit(root.path(), "file.txt", None, "").unwrap();
        assert!(!file.exists());
    }
}
