use crate::utils::{output_with_timeout, AppError, AppResult};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Changes {
    paths: HashSet<PathBuf>,
    error: Option<String>,
}

/// Tracks writes as well as final contents, so editing then reverting during a
/// check cannot silently reuse the original fingerprint as a passing result.
pub(super) struct CodeObserver {
    _watcher: RecommendedWatcher,
    changes: Arc<Mutex<Changes>>,
    root: PathBuf,
    tracked: HashSet<PathBuf>,
}

impl CodeObserver {
    pub(super) fn start(root: &Path) -> AppResult<Self> {
        let tracked = tracked_paths(root)?;
        let changes = Arc::new(Mutex::new(Changes::default()));
        let sink = changes.clone();
        let watch_root = root.to_path_buf();
        let watch_tracked = tracked.clone();
        let mut ignored_parents = HashMap::new();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let mut state = sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            record_event(
                &mut state,
                event,
                &watch_root,
                &watch_tracked,
                &mut ignored_parents,
            );
        })
        .map_err(|error| AppError::from(error.to_string()))?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|error| AppError::from(error.to_string()))?;
        Ok(Self {
            _watcher: watcher,
            changes,
            root: root.to_path_buf(),
            tracked,
        })
    }

    pub(super) fn finish(self) -> AppResult<bool> {
        // Let native notifications queued by the last process writes arrive.
        std::thread::sleep(Duration::from_millis(100));
        let changes = self
            .changes
            .lock()
            .map_err(|_| AppError::from("Code observer lock poisoned"))?;
        if let Some(error) = &changes.error {
            return Err(AppError::from(error.clone()));
        }
        for path in &changes.paths {
            if self.relevant(path)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn relevant(&self, path: &Path) -> AppResult<bool> {
        let Ok(relative) = path.strip_prefix(&self.root) else {
            return Ok(false);
        };
        if relative.as_os_str().is_empty() {
            return Ok(false);
        }
        if relative.starts_with(".git") {
            return Ok(relative == Path::new(".git/HEAD") || relative.starts_with(".git/refs"));
        }
        if self.tracked.contains(relative) {
            return Ok(true);
        }
        // Native directory metadata events accompany ignored build output.
        if path.is_dir() {
            return Ok(false);
        }
        if self
            .tracked
            .iter()
            .any(|tracked| tracked.starts_with(relative))
        {
            return Ok(true);
        }
        let output = output_with_timeout(
            git_command(&self.root)
                .args(["check-ignore", "-q", "--"])
                .arg(relative),
            Duration::from_secs(5),
        )?;
        match output.status.code() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(AppError::from("Could not classify changed code paths")),
        }
    }
}

fn record_event(
    changes: &mut Changes,
    event: notify::Result<Event>,
    root: &Path,
    tracked: &HashSet<PathBuf>,
    ignored_parents: &mut HashMap<PathBuf, bool>,
) {
    let event = match event {
        Ok(event) if event.need_rescan() => {
            changes.error = Some("Filesystem change notifications were incomplete".into());
            return;
        }
        Ok(event) => event,
        Err(error) => {
            changes.error = Some(error.to_string());
            return;
        }
    };
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return;
    }
    for path in event.paths {
        match ignored_build_path(&path, root, tracked, ignored_parents) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) => {
                changes.error = Some(error.to_string());
                continue;
            }
        }
        if changes.paths.len() >= 4096 && !changes.paths.contains(&path) {
            changes.error = Some("Too many filesystem changes to verify code stability".into());
        } else {
            changes.paths.insert(path);
        }
    }
}

// Cache ignored parent directories before collecting events: a build can write
// thousands of target/node_modules files without consuming the code event cap.
fn ignored_build_path(
    path: &Path,
    root: &Path,
    tracked: &HashSet<PathBuf>,
    cache: &mut HashMap<PathBuf, bool>,
) -> AppResult<bool> {
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(true);
    };
    if tracked.contains(relative) {
        return Ok(false);
    }
    if relative.starts_with(".git") {
        return Ok(relative != Path::new(".git/HEAD") && !relative.starts_with(".git/refs"));
    }
    if path.is_dir() {
        return Ok(true);
    }
    let Some(parent) = relative
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    else {
        return Ok(false);
    };
    if let Some(ignored) = cache.get(parent) {
        return Ok(*ignored);
    }
    let mut directory = parent.as_os_str().to_os_string();
    directory.push("/");
    let output = output_with_timeout(
        git_command(root)
            .args(["check-ignore", "-q", "--"])
            .arg(directory),
        Duration::from_secs(5),
    )?;
    let ignored = match output.status.code() {
        Some(0) => true,
        Some(1) => false,
        _ => return Err("Could not classify changed code directories".into()),
    };
    cache.insert(parent.to_path_buf(), ignored);
    Ok(ignored)
}

fn tracked_paths(root: &Path) -> AppResult<HashSet<PathBuf>> {
    let output = output_with_timeout(
        git_command(root).args(["ls-files", "-z"]),
        Duration::from_secs(10),
    )?;
    if !output.status.success() {
        return Err("Cannot inspect tracked verification paths".into());
    }
    let mut paths = HashSet::new();
    for bytes in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|bytes| !bytes.is_empty())
    {
        #[cfg(unix)]
        let path = {
            use std::os::unix::ffi::OsStrExt;
            PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
        };
        #[cfg(not(unix))]
        let path = PathBuf::from(
            std::str::from_utf8(bytes)
                .map_err(|_| AppError::from("Verification path encoding is unsupported"))?,
        );
        paths.insert(path);
    }
    Ok(paths)
}

fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(root);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["--no-optional-locks", "-c", "core.fsmonitor=false"])
        .args(["-c", "core.hooksPath=/dev/null"]);
    command
}
