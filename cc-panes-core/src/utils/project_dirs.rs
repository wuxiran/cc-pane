//! Layout of the per-repository `.ccpanes/` folder (docs/98).
//!
//! `.ccpanes/` is meant to be **committed**: it holds what describes this repository for the
//! team (specs, workflow, config). Everything machine-local — history blobs, media, journals,
//! hook state, externalised prompts — lives under `.ccpanes/.cache/`, which CC-Panes itself
//! fences off with a `.ccpanes/.gitignore`. Every writer goes through this module so no code
//! path can quietly add a new top-level entry.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const CCPANES_DIR: &str = ".ccpanes";
pub const CACHE_DIR: &str = ".cache";
const GITIGNORE_FILE: &str = ".gitignore";
const GITIGNORE_CONTENT: &str =
    "# Written by CC-Panes: machine-local caches never belong in the repository.\n.cache/\n";

/// `<project>/.ccpanes`
pub fn ccpanes_dir(project_path: &Path) -> PathBuf {
    project_path.join(CCPANES_DIR)
}

/// `<project>/.ccpanes/.cache`
pub fn cache_dir(project_path: &Path) -> PathBuf {
    ccpanes_dir(project_path).join(CACHE_DIR)
}

/// A named cache entry (`history`, `media`, `journal`, `prompts`, `cli-hooks.json` …).
pub fn cache_entry(project_path: &Path, name: &str) -> PathBuf {
    cache_dir(project_path).join(name)
}

/// The pre-0.12.10 location of the same entry, directly under `.ccpanes/`.
pub fn legacy_entry(project_path: &Path, name: &str) -> PathBuf {
    ccpanes_dir(project_path).join(name)
}

/// Create `.ccpanes/` and drop the `.gitignore` guard if it is missing. Never overwrites a
/// user-edited `.gitignore`.
pub fn ensure_ccpanes_dir(project_path: &Path) -> io::Result<PathBuf> {
    let dir = ccpanes_dir(project_path);
    fs::create_dir_all(&dir)?;
    let gitignore = dir.join(GITIGNORE_FILE);
    if !gitignore.exists() {
        fs::write(&gitignore, GITIGNORE_CONTENT)?;
    }
    Ok(dir)
}

/// Create `.ccpanes/.cache/` (and the `.gitignore` guard above it).
pub fn ensure_cache_dir(project_path: &Path) -> io::Result<PathBuf> {
    ensure_ccpanes_dir(project_path)?;
    let dir = cache_dir(project_path);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Resolve a cache entry, moving it from the legacy top-level location if that is where it
/// currently lives. Idempotent; a failed rename leaves the legacy path untouched and is
/// reported so callers can fall back to reading it in place.
pub fn ensure_cache_entry(project_path: &Path, name: &str) -> io::Result<PathBuf> {
    ensure_cache_dir(project_path)?;
    let target = cache_entry(project_path, name);
    let legacy = legacy_entry(project_path, name);
    if !target.exists() && legacy.exists() {
        fs::rename(&legacy, &target)?;
    }
    Ok(target)
}

/// Like `ensure_cache_entry` for a *folder* entry: also creates the folder.
pub fn ensure_cache_subdir(project_path: &Path, name: &str) -> io::Result<PathBuf> {
    let dir = ensure_cache_entry(project_path, name)?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Read-side resolution: prefer the cache location, fall back to the legacy one when only that
/// exists. Does not create or move anything.
pub fn resolve_cache_entry(project_path: &Path, name: &str) -> PathBuf {
    let target = cache_entry(project_path, name);
    if target.exists() {
        return target;
    }
    let legacy = legacy_entry(project_path, name);
    if legacy.exists() {
        return legacy;
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn ensure_dirs_write_gitignore_once_and_keep_user_edits() {
        let tmp = TempDir::new().unwrap();
        let cache = ensure_cache_dir(tmp.path()).unwrap();
        assert!(cache.is_dir());
        let gitignore = ccpanes_dir(tmp.path()).join(".gitignore");
        assert!(fs::read_to_string(&gitignore).unwrap().contains(".cache/"));

        fs::write(&gitignore, "custom\n").unwrap();
        ensure_ccpanes_dir(tmp.path()).unwrap();
        assert_eq!(fs::read_to_string(&gitignore).unwrap(), "custom\n");
    }

    #[test]
    fn ensure_cache_entry_migrates_legacy_folder_once() {
        let tmp = TempDir::new().unwrap();
        let legacy = legacy_entry(tmp.path(), "history");
        fs::create_dir_all(legacy.join("blobs")).unwrap();
        fs::write(legacy.join("history.db"), b"db").unwrap();

        let target = ensure_cache_entry(tmp.path(), "history").unwrap();
        assert_eq!(target, cache_entry(tmp.path(), "history"));
        assert!(target.join("history.db").is_file());
        assert!(target.join("blobs").is_dir());
        assert!(!legacy.exists());

        // 再跑一次：目标已存在，不再动
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("stray"), b"x").unwrap();
        ensure_cache_entry(tmp.path(), "history").unwrap();
        assert!(legacy.join("stray").is_file());
    }

    #[test]
    fn resolve_prefers_cache_then_legacy_then_cache_path() {
        let tmp = TempDir::new().unwrap();
        let fresh = resolve_cache_entry(tmp.path(), "media");
        assert_eq!(fresh, cache_entry(tmp.path(), "media"));

        fs::create_dir_all(legacy_entry(tmp.path(), "media")).unwrap();
        assert_eq!(
            resolve_cache_entry(tmp.path(), "media"),
            legacy_entry(tmp.path(), "media")
        );

        fs::create_dir_all(cache_entry(tmp.path(), "media")).unwrap();
        assert_eq!(
            resolve_cache_entry(tmp.path(), "media"),
            cache_entry(tmp.path(), "media")
        );
    }
}
