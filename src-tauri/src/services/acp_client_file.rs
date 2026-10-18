//! Atomic ACP text writes that retain the target's identity through symlinks and
//! preserve its permissions. Each write owns a unique, automatically cleaned temp file.
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

fn write_target(path: &Path) -> io::Result<PathBuf> {
    let mut target = path.to_path_buf();
    // Following the leaf explicitly also supports dangling relative links: the
    // linked file can be created without replacing the link itself.
    for _ in 0..40 {
        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let link = fs::read_link(&target)?;
                target = if link.is_absolute() {
                    link
                } else {
                    target
                        .parent()
                        .ok_or_else(|| io::Error::other("symlink has no parent"))?
                        .join(link)
                };
            }
            Ok(_) => return Ok(target),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(target),
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "too many symlinks in ACP write target",
    ))
}

pub(super) fn write_text(path: &Path, content: &str) -> io::Result<()> {
    let target = write_target(path)?;
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("write target has no parent"))?;
    fs::create_dir_all(parent)?;
    let permissions = match fs::metadata(&target) {
        Ok(meta) if meta.is_file() => Some(meta.permissions()),
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "ACP write target is not a regular file",
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let mut builder = tempfile::Builder::new();
    builder.prefix(".ccpanes-write-").suffix(".tmp");
    #[cfg(unix)]
    if permissions.is_none() {
        use std::os::unix::fs::PermissionsExt;
        // Match File::create for new files: 0666, restricted by the user's umask.
        // Existing private files keep tempfile's 0600 until their original mode
        // is restored after writing, avoiding exposure through the temporary path.
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut temporary = builder.tempfile_in(parent)?;
    temporary.write_all(content.as_bytes())?;
    temporary.as_file().sync_all()?;
    if let Some(permissions) = permissions {
        temporary.as_file().set_permissions(permissions)?;
    }
    // No remove-target or in-place fallback: a failed replace preserves the old
    // contents. PersistError returns our temp file, whose Drop cleans it up.
    persist(temporary, &target)
}

fn persist(temporary: tempfile::NamedTempFile, target: &Path) -> io::Result<()> {
    temporary.persist(target).map_err(|error| {
        #[cfg(windows)]
        if let Ok(meta) = error.file.as_file().metadata() {
            let mut permissions = meta.permissions();
            permissions.set_readonly(false);
            let _ = error.file.as_file().set_permissions(permissions);
        }
        error.error
    })?;
    Ok(())
}

#[cfg(test)]
#[path = "acp_client_file_tests.rs"]
mod tests;
