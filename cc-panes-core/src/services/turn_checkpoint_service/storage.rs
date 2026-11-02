use super::*;
use crate::utils::atomic_file::write_atomic;
use std::fs;

impl TurnCheckpointService {
    pub(super) fn save(&self, record: &TurnCheckpointRecord) -> AppResult<()> {
        let bytes = encode(record)?;
        if bytes.len() > 64 * 1024 {
            return Err("Checkpoint metadata exceeds its storage limit".into());
        }
        prepare(&self.directory)?;
        write_atomic(&self.path(&record.id)?, bytes)?;
        Ok(())
    }

    pub(super) fn load(&self, id: &str) -> AppResult<TurnCheckpointRecord> {
        prepare(&self.directory)?;
        let path = self.path(id)?;
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.len() > 64 * 1024 {
            return Err("Checkpoint metadata is not a bounded regular file".into());
        }
        let record: TurnCheckpointRecord = serde_json::from_slice(&fs::read(path)?)
            .map_err(|error| AppError::from(error.to_string()))?;
        if record.id != id {
            return Err("Checkpoint identity does not match its file".into());
        }
        Ok(record)
    }

    pub(super) fn read_records(&self, chat_id: &str) -> AppResult<Vec<TurnCheckpointRecord>> {
        if !self.directory.exists() {
            return Ok(Vec::new());
        }
        prepare(&self.directory)?;
        let mut records = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let path = entry?.path();
            if path.extension().and_then(|part| part.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|part| part.to_str()) else {
                continue;
            };
            let record = self.load(id)?;
            if record.chat_id == chat_id {
                records.push(record);
            }
        }
        records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        records.truncate(200);
        Ok(records)
    }

    fn path(&self, id: &str) -> AppResult<PathBuf> {
        uuid::Uuid::parse_str(id).map_err(|_| AppError::from("Invalid checkpoint ID"))?;
        Ok(self.directory.join(format!("{id}.json")))
    }

    pub(super) fn recovery(
        &self,
        id: &str,
        current: &crate::models::RepositorySnapshot,
    ) -> AppResult<String> {
        let recovery_id = format!("restore-{}", uuid::Uuid::new_v4());
        self.snapshots.pin(current, &recovery_id)?;
        let directory = self.directory.join("recoveries");
        prepare(&directory)?;
        write_atomic(
            &directory.join(format!("{recovery_id}.json")),
            encode(&serde_json::json!({"checkpointId": id, "beforeRestore": current}))?,
        )?;
        Ok(recovery_id)
    }
}

fn prepare(path: &Path) -> AppResult<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Checkpoint storage must be a real directory".into());
        }
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn encode(value: &impl serde::Serialize) -> AppResult<Vec<u8>> {
    serde_json::to_vec(value).map_err(|error| AppError::from(error.to_string()))
}
