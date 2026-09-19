//! Claude may reuse its MCP path when handing a foreground session to a job.
//! PTY exit is therefore a retirement signal, not permission to delete immediately.
//! Unknown/legacy files have no retirement evidence and are deliberately retained.
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const RETIRED_CONFIG_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn is_claude_config(name: &str) -> bool {
    let Some(id) = name
        .strip_prefix("wsl-claude-mcp-")
        .or_else(|| name.strip_prefix("mcp-"))
        .and_then(|name| name.strip_suffix(".json"))
    else {
        return false;
    };
    // PTY ids are UUIDs. In particular, mcp-pi-*.json is not ours.
    id.len() == 36
        && id.bytes().enumerate().all(|(index, ch)| {
            if [8, 13, 18, 23].contains(&index) {
                ch == b'-'
            } else {
                ch.is_ascii_hexdigit()
            }
        })
}

fn marker_path(config: &Path) -> PathBuf {
    config.with_extension("json.retired")
}

/// Called only when the owning PTY actually exits or is killed. Repeated exit
/// notifications do not restart the retention period. No credentials are copied.
pub fn retire_config(config: &Path) -> io::Result<()> {
    if !config
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_claude_config)
        || !config.is_file()
    {
        return Ok(());
    }
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker_path(config))
    {
        Ok(mut marker) => marker.write_all(b"cc-panes-claude-retired-v1\n"),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

/// Clear retirement before publishing a newly generated config at this path.
pub fn prepare_config(config: &Path) -> io::Result<()> {
    match fs::remove_file(marker_path(config)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// A file's age alone cannot prove its session is dead. Only our explicit exit
/// markers permit collection; files without one survive daemon/app restarts.
pub fn collect_retired_configs(data_dir: &Path, current_file: &str) {
    collect_at(data_dir, current_file, SystemTime::now());
}

fn collect_at(data_dir: &Path, current_file: &str, now: SystemTime) {
    let Ok(entries) = fs::read_dir(data_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == current_file || !is_claude_config(&name) {
            continue;
        }
        let config = entry.path();
        let marker = marker_path(&config);
        // Do not follow symlinks for either the config or its ownership marker.
        let regular = |path: &Path| fs::symlink_metadata(path).is_ok_and(|m| m.is_file());
        if !regular(&config)
            || !regular(&marker)
            || fs::read(&marker).ok().as_deref() != Some(b"cc-panes-claude-retired-v1\n")
        {
            continue;
        }
        let expired = fs::metadata(&marker)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > RETIRED_CONFIG_RETENTION);
        if expired {
            if let Err(error) = fs::remove_file(&config).and_then(|_| fs::remove_file(&marker)) {
                tracing::warn!(path = %config.display(), %error, "Failed to collect retired Claude MCP config");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "11111111-aaaa-bbbb-cccc-222222222222";
    fn write(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"{}").unwrap();
        path
    }

    #[test]
    fn long_running_and_legacy_configs_are_never_collected_by_age() {
        let dir = tempfile::tempdir().unwrap();
        let local = write(dir.path(), &format!("mcp-{ID}.json"));
        let wsl = write(dir.path(), &format!("wsl-claude-mcp-{ID}.json"));
        collect_at(
            dir.path(),
            "new.json",
            SystemTime::now() + RETIRED_CONFIG_RETENTION * 10,
        );
        assert!(local.exists());
        assert!(wsl.exists());
    }

    #[test]
    fn exit_retains_config_then_gc_collects_after_grace_period() {
        let dir = tempfile::tempdir().unwrap();
        for prefix in ["mcp-", "wsl-claude-mcp-"] {
            let path = write(dir.path(), &format!("{prefix}{ID}.json"));
            retire_config(&path).unwrap();
            collect_retired_configs(dir.path(), "new.json");
            assert!(path.exists(), "PTY exit must preserve a possible handoff");
            collect_at(
                dir.path(),
                "new.json",
                SystemTime::now() + RETIRED_CONFIG_RETENTION * 2,
            );
            assert!(!path.exists());
            assert!(!marker_path(&path).exists());
        }
    }

    #[test]
    fn pi_unrelated_current_and_invalid_markers_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let current_name = format!("mcp-{ID}.json");
        for name in [
            format!("mcp-pi-{ID}.json"),
            "mcp-orchestrator.json".into(),
            current_name.clone(),
        ] {
            let path = write(dir.path(), &name);
            fs::write(marker_path(&path), b"cc-panes-claude-retired-v1\n").unwrap();
            collect_at(
                dir.path(),
                &current_name,
                SystemTime::now() + RETIRED_CONFIG_RETENTION * 2,
            );
            assert!(path.exists());
        }
        let invalid = write(dir.path(), &format!("wsl-claude-mcp-{ID}.json"));
        fs::write(marker_path(&invalid), b"invalid").unwrap();
        collect_at(
            dir.path(),
            &current_name,
            SystemTime::now() + RETIRED_CONFIG_RETENTION * 2,
        );
        assert!(invalid.exists());
    }

    #[test]
    fn republishing_clears_retirement_and_repeated_exit_does_not_extend_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), &format!("mcp-{ID}.json"));
        retire_config(&path).unwrap();
        let marker = marker_path(&path);
        let old = SystemTime::now() - RETIRED_CONFIG_RETENTION * 2;
        fs::OpenOptions::new()
            .write(true)
            .open(&marker)
            .unwrap()
            .set_modified(old)
            .unwrap();
        retire_config(&path).unwrap();
        assert!(
            fs::metadata(&marker).unwrap().modified().unwrap()
                < SystemTime::now() - RETIRED_CONFIG_RETENTION
        );
        prepare_config(&path).unwrap();
        collect_retired_configs(dir.path(), "new.json");
        assert!(path.exists());
        assert!(!marker.exists());
    }
}
