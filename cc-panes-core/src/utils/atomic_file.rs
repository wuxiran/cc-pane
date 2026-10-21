use std::ffi::OsStr;
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// 写临时文件并 `sync_all()`——rename 前确保数据真正落盘，避免断电后目标为 0 字节。
fn write_and_sync(temp_path: &Path, content: &[u8]) -> Result<()> {
    let mut file = File::create(temp_path)
        .with_context(|| format!("failed to create temp file {}", temp_path.display()))?;
    file.write_all(content)
        .with_context(|| format!("failed to write temp file {}", temp_path.display()))?;
    file.sync_all()
        .with_context(|| format!("failed to fsync temp file {}", temp_path.display()))?;
    Ok(())
}

pub fn write_atomic(path: &Path, content: impl AsRef<[u8]>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create parent directory {}", parent.display()))?;
    }

    let temp_path = sibling_temp_path(path);
    if let Err(error) = write_and_sync(&temp_path, content.as_ref()) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    let result = replace_file(&temp_path, path);
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn sibling_temp_path(path: &Path) -> PathBuf {
    let mut file_name = path
        .file_name()
        .unwrap_or_else(|| OsStr::new("cc-panes"))
        .to_os_string();
    file_name.push(format!(
        ".tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    ));
    path.with_file_name(file_name)
}

fn replace_file(temp_path: &Path, path: &Path) -> Result<()> {
    // std::fs::rename already replaces files on Windows (MOVEFILE_REPLACE_EXISTING)
    // as well as Unix. Never delete the destination to retry a failed rename:
    // a missing/locked source or another I/O failure would destroy the last good file.
    // https://doc.rust-lang.org/std/fs/fn.rename.html
    fs::rename(temp_path, path).with_context(|| {
        format!(
            "failed to replace {} with temp file {}",
            path.display(),
            temp_path.display(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_creates_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");

        write_atomic(&path, "a = 1\n").unwrap();

        assert_eq!(fs::read_to_string(path).unwrap(), "a = 1\n");
    }

    #[test]
    fn write_atomic_replaces_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "old\n").unwrap();

        write_atomic(&path, "new\n").unwrap();

        assert_eq!(fs::read_to_string(path).unwrap(), "new\n");
    }

    #[test]
    fn failed_rename_never_deletes_the_previous_file() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("config.json");
        fs::write(&destination, "last good configuration").unwrap();

        // A source can disappear or become inaccessible after staging. The old
        // Windows delete-then-retry path destroyed the destination on this error.
        assert!(replace_file(&dir.path().join("missing.tmp"), &destination).is_err());
        assert_eq!(
            fs::read_to_string(&destination).unwrap(),
            "last good configuration"
        );
    }

    #[test]
    fn failed_atomic_replace_preserves_the_destination_and_cleans_staging() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("config");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep"), "unchanged").unwrap();

        assert!(write_atomic(&destination, "replacement").is_err());
        assert_eq!(
            fs::read_to_string(destination.join("keep")).unwrap(),
            "unchanged"
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn locked_staging_file_does_not_remove_the_previous_configuration() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("config.json");
        let staging = dir.path().join("staging.tmp");
        fs::write(&destination, "last good configuration").unwrap();
        fs::write(&staging, "replacement").unwrap();
        // Permit reads/writes but not deletion/rename of the source. The target
        // remains removable, exercising the old fallback's data-loss sequence.
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x00000001 | 0x00000002)
            .open(&staging)
            .unwrap();
        let replaced = replace_file(&staging, &destination);
        drop(locked);
        assert!(replaced.is_err());
        assert_eq!(
            fs::read_to_string(destination).unwrap(),
            "last good configuration"
        );
        assert_eq!(fs::read_to_string(staging).unwrap(), "replacement");
    }
}
