use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

fn create_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Write, flush, and rename a sibling temp file so a partial JSON/JS file is never exposed.
pub fn write_atomic(path: &Path, content: impl AsRef<[u8]>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create parent directory {}", parent.display()))?;
    }
    let temp_path = sibling_temp_path(path);
    let result = (|| {
        let mut file = create_private_file(&temp_path)
            .with_context(|| format!("failed to create temp file {}", temp_path.display()))?;
        file.write_all(content.as_ref())
            .with_context(|| format!("failed to write temp file {}", temp_path.display()))?;
        file.sync_all()
            .with_context(|| format!("failed to sync temp file {}", temp_path.display()))?;
        drop(file);
        replace_file(&temp_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

/// Like `write_atomic`, but never replaces an existing path. This is used for project assets where
/// a user-owned file must win a race with CC-Panes initialization.
pub fn write_atomic_if_absent(path: &Path, content: impl AsRef<[u8]>) -> Result<bool> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create parent directory {}", parent.display()))?;
    }
    let temp_path = sibling_temp_path(path);
    let result = (|| {
        let mut file = create_private_file(&temp_path)
            .with_context(|| format!("failed to create temp file {}", temp_path.display()))?;
        file.write_all(content.as_ref())?;
        file.sync_all()?;
        drop(file);
        // A hard link installs the already-synced inode without replacing a user-created target;
        // unlike rename, this has the same no-overwrite behavior on Unix and Windows.
        match fs::hard_link(&temp_path, path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error)
                .with_context(|| format!("failed to install temp file {}", temp_path.display())),
        }
    })();
    if matches!(result, Ok(true) | Ok(false)) {
        let _ = fs::remove_file(&temp_path);
    }
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn sibling_temp_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .unwrap_or_else(|| OsStr::new("cc-panes"))
        .to_os_string();
    name.push(format!(
        ".tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    ));
    path.with_file_name(name)
}

// 两个分支各自是完整函数体，`return` 由 cfg 结构决定：Windows 上 cfg(not(windows))
// 那段被整块剥掉，此处若去掉 return 就没有尾表达式了。
#[allow(clippy::needless_return)]
fn replace_file(temp_path: &Path, path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS};

        let to_wide = |value: &Path| {
            value
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<u16>>()
        };
        let replacement = to_wide(temp_path);
        let target = to_wide(path);
        // ReplaceFileW performs the replacement without deleting the old file first. If the
        // target does not exist, fall back to rename; a race that creates it is retried through
        // ReplaceFileW and still never removes the user's file speculatively.
        if path.exists() {
            unsafe {
                ReplaceFileW(
                    PCWSTR(target.as_ptr()),
                    PCWSTR(replacement.as_ptr()),
                    PCWSTR::null(),
                    REPLACE_FILE_FLAGS(0),
                    None,
                    None,
                )
                .with_context(|| format!("failed to atomically replace {}", path.display()))?;
            }
            return Ok(());
        }
        return match fs::rename(temp_path, path) {
            Ok(()) => Ok(()),
            Err(rename_error) if path.exists() => unsafe {
                ReplaceFileW(
                    PCWSTR(target.as_ptr()),
                    PCWSTR(replacement.as_ptr()),
                    PCWSTR::null(),
                    REPLACE_FILE_FLAGS(0),
                    None,
                    None,
                )
                .with_context(|| {
                    format!(
                        "failed to replace {} after initial rename error: {rename_error}",
                        path.display()
                    )
                })
            },
            Err(error) => Err(error)
                .with_context(|| format!("failed to rename temp file {}", temp_path.display())),
        };
    }

    #[cfg(not(windows))]
    match fs::rename(temp_path, path) {
        Ok(()) => Ok(()),
        Err(error) => Err(error)
            .with_context(|| format!("failed to rename temp file {}", temp_path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces_without_partial_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        write_atomic(&path, b"{\"value\":1}").unwrap();
        write_atomic(&path, b"{\"value\":2}").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "{\"value\":2}");
    }

    #[test]
    fn does_not_replace_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("theme.json");
        fs::write(&path, b"user").unwrap();
        assert!(!write_atomic_if_absent(&path, b"ccpanes").unwrap());
        assert_eq!(fs::read_to_string(path).unwrap(), "user");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn writes_private_files_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider.json");
        write_atomic(&path, b"secret").unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(windows)]
    #[test]
    fn failed_replace_preserves_existing_windows_file() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, b"old").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        assert!(write_atomic(&path, b"new").is_err());
        drop(lock);
        assert_eq!(fs::read_to_string(path).unwrap(), "old");
    }
}
