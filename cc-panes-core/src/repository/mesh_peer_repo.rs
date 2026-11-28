//! Bot 组网对端记录（docs/112 §5）：地址候选、实例 id、最近在线。

use std::sync::Arc;

use chrono::Utc;
use rusqlite::{params, OptionalExtension, Row};
use tracing::error;

use crate::models::{MeshAddress, MeshPeerRecord};
use crate::repository::Database;

pub struct MeshPeerRepository {
    db: Arc<Database>,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<MeshPeerRecord> {
    let addresses_json: String = row.get(3)?;
    let addresses: Vec<MeshAddress> = serde_json::from_str(&addresses_json).unwrap_or_default();
    Ok(MeshPeerRecord {
        device_id: row.get(0)?,
        instance_id: row.get(1)?,
        hostname: row.get(2)?,
        addresses,
        preferred_url: row.get(4)?,
        last_seen_at: row.get(5)?,
        last_error: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

const COLUMNS: &str = "device_id, instance_id, hostname, addresses_json, preferred_url, last_seen_at, last_error, updated_at";

impl MeshPeerRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> Result<Vec<MeshPeerRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM mesh_peers ORDER BY device_id"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn get(&self, device_id: &str) -> Result<Option<MeshPeerRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.query_row(
            &format!("SELECT {COLUMNS} FROM mesh_peers WHERE device_id = ?1"),
            params![device_id],
            from_row,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// 整行写入（不存在则插入）。`updated_at` 由仓库填。
    pub fn upsert(&self, record: &MeshPeerRecord) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let addresses = serde_json::to_string(&record.addresses).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO mesh_peers (device_id, instance_id, hostname, addresses_json, preferred_url, last_seen_at, last_error, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(device_id) DO UPDATE SET
                instance_id = excluded.instance_id,
                hostname = excluded.hostname,
                addresses_json = excluded.addresses_json,
                preferred_url = excluded.preferred_url,
                last_seen_at = excluded.last_seen_at,
                last_error = excluded.last_error,
                updated_at = excluded.updated_at",
            params![
                record.device_id,
                record.instance_id,
                record.hostname,
                addresses,
                record.preferred_url,
                record.last_seen_at,
                record.last_error,
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|e| {
            error!(table = "mesh_peers", err = %e, "SQL upsert failed");
            e.to_string()
        })?;
        Ok(())
    }

    pub fn delete(&self, device_id: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM mesh_peers WHERE device_id = ?1",
            params![device_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MeshAddressSource;

    fn repo() -> MeshPeerRepository {
        MeshPeerRepository::new(Arc::new(Database::new_in_memory().expect("db")))
    }

    #[test]
    fn upsert_get_list_delete_roundtrip() {
        let repo = repo();
        assert!(repo.get("d1").unwrap().is_none());
        let mut record = MeshPeerRecord {
            device_id: "d1".into(),
            instance_id: Some("inst".into()),
            ..Default::default()
        };
        record.merge_address("http://192.168.1.5:18080", MeshAddressSource::Lan);
        repo.upsert(&record).unwrap();
        record.preferred_url = Some("http://192.168.1.5:18080".into());
        record.last_seen_at = Some("2026-01-01T00:00:00Z".into());
        repo.upsert(&record).unwrap();
        let loaded = repo.get("d1").unwrap().unwrap();
        assert_eq!(loaded.instance_id.as_deref(), Some("inst"));
        assert_eq!(loaded.addresses.len(), 1);
        assert_eq!(loaded.preferred_url, record.preferred_url);
        assert!(!loaded.updated_at.is_empty());
        assert_eq!(repo.list().unwrap().len(), 1);
        repo.delete("d1").unwrap();
        assert!(repo.list().unwrap().is_empty());
    }
}
