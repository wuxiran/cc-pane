//! Serialize registry mutations across desktop, Web and other processes.
//!
//! A separate SQLite reservation acts as an OS-released cross-process lock. It is
//! never renamed with a workspace and survives crashes without a stale lockfile.
//! Hold it for the whole read/modify/write operation, not just the final write.
use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;

pub(super) struct RegistryWriteGuard {
    _connection: Connection,
}

impl RegistryWriteGuard {
    pub(super) fn acquire(base_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(base_dir)
            .map_err(|error| format!("Failed to create workspace registry: {error}"))?;
        let connection = Connection::open(base_dir.join(".workspace-write-lock.sqlite3"))
            .map_err(|error| format!("Failed to open workspace transaction lock: {error}"))?;
        connection
            .busy_timeout(Duration::from_secs(30))
            .and_then(|()| connection.execute_batch("BEGIN IMMEDIATE"))
            .map_err(|error| format!("Workspace registry is busy or unavailable: {error}"))?;
        // Connection::drop rolls back this reservation and releases the OS lock.
        Ok(Self {
            _connection: connection,
        })
    }
}
