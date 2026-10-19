use crate::utils::{output_with_timeout_limit, AppError, AppResult, GIT_LOCAL_TIMEOUT};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

pub(super) struct Scratch(pub PathBuf);
impl Scratch {
    pub fn new(directory: &Path) -> AppResult<Self> {
        prepare_directory(directory)?;
        let root = directory.join("scratch");
        prepare_directory(&root)?;
        let path = root.join(uuid::Uuid::new_v4().to_string());
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        // Unique scratch directories are private from the moment they exist.
        builder.create(&path)?;
        reject_link(directory)?;
        reject_link(&root)?;
        Ok(Self(path))
    }
}

pub(super) fn prepare_directory(directory: &Path) -> AppResult<()> {
    reject_link(directory)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory)?;
    reject_link(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let handle = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(directory)?;
        handle.set_permissions(fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn reject_link(path: &Path) -> AppResult<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let unsafe_path = metadata.file_type().is_symlink() || !metadata.is_dir();
    #[cfg(windows)]
    let unsafe_path = {
        use std::os::windows::fs::MetadataExt;
        unsafe_path || metadata.file_attributes() & 0x400 != 0
    };
    if unsafe_path {
        return Err(format!("Fork review storage must be a real directory, not a symbolic link or reparse point: {}", path.display()).into());
    }
    Ok(())
}
impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            tracing::warn!(%error, "could not remove fork review scratch directory");
        }
    }
}

pub(super) fn command(repository: &Path, index: Option<&Path>) -> Command {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .current_dir(repository)
        .arg("--git-dir")
        .arg(repository)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
        ])
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    command
}

pub(super) fn run(command: &mut Command) -> AppResult<Output> {
    Ok(output_with_timeout_limit(
        command,
        GIT_LOCAL_TIMEOUT,
        16 * 1024 * 1024,
    )?)
}

pub(super) fn checked(command: &mut Command) -> AppResult<Vec<u8>> {
    let output = run(command)?;
    if !output.status.success() {
        return Err(AppError::from(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(output.stdout)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn scratch_is_private_before_any_merge_contents_are_written() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("fork-reviews");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        let scratch = Scratch::new(&directory).unwrap();
        for path in [&directory, &directory.join("scratch"), &scratch.0] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        fs::write(scratch.0.join("parent"), b"private source contents").unwrap();
        let path = scratch.0.clone();
        drop(scratch);
        assert!(!path.exists());
    }

    #[test]
    fn scratch_rejects_symlinked_management_roots_without_touching_targets() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o755)).unwrap();
        let directory = temp.path().join("fork-reviews");
        symlink(&outside, &directory).unwrap();
        assert!(Scratch::new(&directory).is_err());
        fs::remove_file(&directory).unwrap();
        fs::create_dir(&directory).unwrap();
        symlink(&outside, directory.join("scratch")).unwrap();
        assert!(Scratch::new(&directory).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        assert_eq!(
            fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}
