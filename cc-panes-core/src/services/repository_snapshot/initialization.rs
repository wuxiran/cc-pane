//! A per-repository SQLite reservation covers only first-time Git setup. A ready
//! marker is published after init/config, so HEAD appearing mid-init is not
//! mistaken for completion by another process. Normal captures never lock.
use super::git;
use crate::utils::AppResult;
use rusqlite::{Connection, TransactionBehavior};
use std::fs;
use std::path::Path;
use std::time::Duration;

const READY_FILE: &str = "cc-panes-snapshot-ready-v1";

pub(super) fn ensure(repository: &Path, format: &str) -> AppResult<()> {
    let ready = repository.join(READY_FILE);
    if ready.is_file() {
        return Ok(());
    }
    let mut connection = Connection::open(repository.join("cc-panes-initialization.sqlite3"))?;
    connection.busy_timeout(Duration::from_secs(30))?;
    let reservation = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !ready.is_file() {
        reservation.execute_batch(
            "CREATE TABLE IF NOT EXISTS initialization_lock (id INTEGER PRIMARY KEY CHECK (id = 1))",
        )?;
        initialize(repository, format)?;
        // Publish readiness only after every required Git mutation succeeded.
        fs::write(&ready, b"1\n")?;
    }
    reservation.commit()?;
    Ok(())
}

fn initialize(repository: &Path, format: &str) -> AppResult<()> {
    // Re-running init repairs an interrupted first attempt. This repository is
    // private, and the cross-process reservation excludes other initializers.
    let mut command = git::command(repository);
    command
        .args(["init", "--bare", &format!("--object-format={format}")])
        .arg(repository);
    git::run(command, vec![])?;
    let mut config = git::private(repository);
    config.args(["config", "gc.auto", "0"]);
    git::run(config, vec![])?;
    Ok(())
}
