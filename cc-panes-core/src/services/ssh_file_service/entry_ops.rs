//! Operations on directory entries must preserve the final symbolic link.
//! Content reads may resolve the full path; deletion and rename must not.

use super::{display_path, join_remote_path};
use anyhow::{bail, Context, Result};
use ssh2::{OpenFlags, OpenType, Sftp};
use std::path::{Path, PathBuf};

/// The SFTP operations used by entry mutations, also exercised without an SSH daemon.
pub(super) trait EntryFs {
    fn realpath(&self, path: &Path) -> Result<PathBuf>;
    fn is_directory_entry(&self, path: &Path) -> Result<bool>;
    fn children(&self, path: &Path) -> Result<Vec<PathBuf>>;
    fn remove_directory(&self, path: &Path) -> Result<()>;
    fn unlink(&self, path: &Path) -> Result<()>;
    fn open_file(&self, path: &Path, flags: OpenFlags) -> Result<()>;
}

impl EntryFs for Sftp {
    fn realpath(&self, path: &Path) -> Result<PathBuf> {
        Ok(Sftp::realpath(self, path)?)
    }

    fn is_directory_entry(&self, path: &Path) -> Result<bool> {
        let stat = self.lstat(path)?;
        Ok(stat.is_dir() && !stat.file_type().is_symlink())
    }

    fn children(&self, path: &Path) -> Result<Vec<PathBuf>> {
        Ok(self
            .readdir(path)?
            .into_iter()
            .map(|(path, _)| path)
            .collect())
    }

    fn remove_directory(&self, path: &Path) -> Result<()> {
        Ok(self.rmdir(path)?)
    }

    fn unlink(&self, path: &Path) -> Result<()> {
        Ok(Sftp::unlink(self, path)?)
    }

    fn open_file(&self, path: &Path, flags: OpenFlags) -> Result<()> {
        self.open_mode(path, flags, 0o644, OpenType::File)?
            .close()?;
        Ok(())
    }
}

/// Canonicalize only the parent, retaining links (including dangling links) as entries.
pub(super) fn resolve_entry(fs: &impl EntryFs, input: &str) -> Result<PathBuf> {
    let input = input.trim_end_matches('/');
    if !input.starts_with('/') && !input.starts_with("~/") {
        bail!("Remote entry path must be absolute or start with ~/");
    }
    let (parent, name) = input
        .rsplit_once('/')
        .context("Remote entry has no parent directory")?;
    if name.is_empty() || matches!(name, "." | "..") || input.contains('\0') {
        bail!("Refusing to modify the remote root or a directory navigation entry");
    }
    let parent = if parent == "~" {
        fs.realpath(Path::new("."))?
    } else if let Some(suffix) = parent.strip_prefix("~/") {
        fs.realpath(&join_remote_path(&fs.realpath(Path::new("."))?, suffix))?
    } else {
        fs.realpath(Path::new(if parent.is_empty() { "/" } else { parent }))?
    };
    Ok(join_remote_path(&parent, name))
}

pub(super) fn create_file(fs: &impl EntryFs, path: &Path) -> Result<()> {
    // EXCLUSIVE includes CREATE and rejects existing files/links atomically. A
    // preceding stat would still allow a concurrent creation to be truncated.
    fs.open_file(path, OpenFlags::WRITE | OpenFlags::EXCLUSIVE)
        .with_context(|| format!("Failed to create remote file {}", display_path(path)))
}

pub(super) fn delete_entry(fs: &impl EntryFs, input: &str) -> Result<()> {
    delete_resolved_entry(fs, &resolve_entry(fs, input)?)
}

fn delete_resolved_entry(fs: &impl EntryFs, path: &Path) -> Result<()> {
    let directory = fs
        .is_directory_entry(path)
        .with_context(|| format!("Failed to inspect remote entry {}", display_path(path)))?;
    if directory {
        for child in fs
            .children(path)
            .with_context(|| format!("Failed to list remote directory {}", display_path(path)))?
        {
            delete_resolved_entry(fs, &child)?;
        }
        fs.remove_directory(path)
            .with_context(|| format!("Failed to delete remote directory {}", display_path(path)))
    } else {
        fs.unlink(path)
            .with_context(|| format!("Failed to delete remote file {}", display_path(path)))
    }
}

#[cfg(test)]
mod tests;
