use crate::models::task_verification::TaskVerificationEvidence;
use crate::utils::{AppError, AppResult};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

/// The OS releases this lease after the host and all inheriting check children exit.
/// A crashed Unix host therefore leaves running/unknown work locked, never passed.
pub(super) struct TaskLock {
    _file: File,
}

impl TaskLock {
    pub(super) fn inherit_into(&self, command: &mut tokio::process::Command) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let fd = self._file.as_raw_fd();
            // Keep the same flock open description alive in the child. A hard
            // host crash cannot release the lease while its check still runs.
            // SAFETY: fcntl is async-signal-safe; no allocation/locks in pre_exec.
            unsafe {
                command.pre_exec(move || {
                    if libc::fcntl(fd, libc::F_DUPFD, 3) < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
        }
        #[cfg(windows)]
        let _ = command; // Job kill-on-close ends children if the host dies.
    }
}

pub(super) fn try_lock(directory: &Path) -> AppResult<Option<TaskLock>> {
    prepare_directory(directory)?;
    let mut options = private_file_options();
    let file = options
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("execution.lock"))?;
    if lock_file(&file)? {
        Ok(Some(TaskLock { _file: file }))
    } else {
        Ok(None)
    }
}

fn prepare_directory(directory: &Path) -> AppResult<()> {
    let root = directory
        .parent()
        .filter(|root| root.file_name() == Some(std::ffi::OsStr::new("task-verification")))
        .ok_or("Invalid managed verification directory")?;
    if let Some(data_dir) = root.parent() {
        std::fs::create_dir_all(data_dir)?;
    }
    ensure_private_directory(root)?;
    ensure_private_directory(directory)
}

fn ensure_private_directory(path: &Path) -> AppResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("Verification storage must be a directory without symlinks".into())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            let builder = {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = builder;
                builder.mode(0o700);
                builder
            };
            match builder.create(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Verification storage must be a directory without symlinks".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        // Set permissions through a non-following directory handle.
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)?;
        directory.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn private_file_options() -> OpenOptions {
    let options = OpenOptions::new();
    #[cfg(unix)]
    let options = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = options;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        options
    };
    options
}

#[cfg(unix)]
fn lock_file(file: &File) -> AppResult<bool> {
    use std::os::fd::AsRawFd;
    // SAFETY: the file remains owned by TaskLock for the entire critical section.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::WouldBlock {
        Ok(false)
    } else {
        Err(error.into())
    }
}

#[cfg(windows)]
fn lock_file(file: &File) -> AppResult<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{ERROR_LOCK_VIOLATION, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows::Win32::System::IO::OVERLAPPED;
    let mut overlapped = OVERLAPPED::default();
    let result = unsafe {
        LockFileEx(
            HANDLE(file.as_raw_handle()),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            None,
            1,
            0,
            &mut overlapped,
        )
    };
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.code() == ERROR_LOCK_VIOLATION.to_hresult() => Ok(false),
        Err(error) => Err(AppError::from(error.to_string())),
    }
}

pub(super) fn save(directory: &Path, evidence: &TaskVerificationEvidence) -> AppResult<()> {
    prepare_directory(directory)?;
    let bytes = serde_json::to_vec(evidence).map_err(|error| AppError::from(error.to_string()))?;
    let temporary = directory.join(format!("{}.tmp", evidence.id));
    let destination = directory.join(format!("{}.json", evidence.id));
    let mut file = private_file_options()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    std::fs::rename(temporary, destination)?;
    Ok(())
}

pub(super) fn load(directory: &Path, task_id: &str) -> AppResult<Vec<TaskVerificationEvidence>> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut evidence = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "json")
        {
            continue;
        }
        if entry.metadata()?.len() > 2 * 1024 * 1024 {
            return Err(AppError::from(
                "Verification evidence exceeds its size limit",
            ));
        }
        let item: TaskVerificationEvidence = serde_json::from_slice(&std::fs::read(entry.path())?)
            .map_err(|error| AppError::from(format!("Invalid verification evidence: {error}")))?;
        if item.task_id != task_id {
            return Err(AppError::from(
                "Verification evidence belongs to a different task",
            ));
        }
        evidence.push(item);
    }
    evidence.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    Ok(evidence)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn child_keeps_task_lease_when_the_host_descriptor_closes() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("task-verification/test-task");
        let lease = try_lock(&directory).unwrap().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "sleep 0.2"]);
            lease.inherit_into(&mut command);
            let mut child = command.spawn().unwrap();
            drop(lease);
            assert!(try_lock(&directory).unwrap().is_none());
            child.wait().await.unwrap();
            assert!(try_lock(&directory).unwrap().is_some());
        });
    }

    fn evidence() -> TaskVerificationEvidence {
        serde_json::from_value(serde_json::json!({
            "id": "evidence", "taskId": "test-task", "command": "echo ok", "cwd": "/repo",
            "startedAt": "2026-10-19T00:00:00Z", "completedAt": "2026-10-19T00:00:01Z",
            "durationMs": 1000, "timeoutSecs": 5, "exitCode": 0, "signal": null,
            "timedOut": false, "stdout": "private output", "stderr": "",
            "outputTruncated": false, "executionError": null, "originalFingerprint": "before",
            "finalFingerprint": "before", "codeChangedDuringRun": false,
            "observationError": null, "freshness": "current"
        }))
        .unwrap()
    }

    #[test]
    fn managed_directories_and_evidence_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("task-verification");
        let directory = root.join("test-task");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _lease = try_lock(&directory).unwrap().unwrap();
        save(&directory, &evidence()).unwrap();
        for path in [&root, &directory] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        for name in ["execution.lock", "evidence.json"] {
            assert_eq!(
                std::fs::metadata(directory.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn rejects_symlink_managed_root_and_task_directory() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let outside = temporary.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let root = temporary.path().join("task-verification");
        let directory = root.join("test-task");
        symlink(&outside, &root).unwrap();
        assert!(try_lock(&directory).is_err());
        assert!(save(&directory, &evidence()).is_err());
        std::fs::remove_file(&root).unwrap();
        std::fs::create_dir(&root).unwrap();
        symlink(&outside, &directory).unwrap();
        assert!(try_lock(&directory).is_err());
        assert!(save(&directory, &evidence()).is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }
}
