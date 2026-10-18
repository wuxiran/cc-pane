use serde::{Deserialize, Serialize};

/// A working-tree tree held in the application's private Git object database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub repository_root: String,
    pub head: String,
    pub tree: String,
    pub fingerprint: String,
    pub snapshot_repository: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub path: String,
    pub mode: String,
    pub oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotFile {
    pub bytes: Vec<u8>,
    pub mode: String,
}
