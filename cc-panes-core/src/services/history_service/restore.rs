use super::HistoryService;
use crate::models::{HistoryLabel, LabelFileSnapshot};
use crate::repository::HistoryFileRepository;
use crate::utils::atomic_file::write_atomic;
use anyhow::{bail, ensure, Context, Result};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

struct RestoreFile {
    relative: String,
    content: Vec<u8>,
}

impl HistoryService {
    pub fn restore_version(&self, project: &Path, file: &str, version: &str) -> Result<()> {
        let repo = self.get_or_create_repo(project)?;
        let _files = repo.lock_files();
        let content = repo.get_version_content(file, version)?;
        self.apply_restore(
            project,
            &repo,
            vec![RestoreFile {
                relative: file.into(),
                content,
            }],
            &format!("Before Restore: {file}"),
        )?;
        Ok(())
    }

    pub fn restore_to_label(&self, project: &Path, label_id: &str) -> Result<Vec<String>> {
        let repo = self.get_or_create_repo(project)?;
        let _files = repo.lock_files();
        let label = repo
            .list_labels()?
            .into_iter()
            .find(|label| label.id == label_id)
            .context("Label not found")?;
        // Read every target before backing up or changing any working file.
        let files = label
            .file_snapshots
            .iter()
            .map(|snapshot| {
                Ok(RestoreFile {
                    relative: snapshot.file_path.clone(),
                    content: repo
                        .get_version_content(&snapshot.file_path, &snapshot.version_id)
                        .with_context(|| format!("Snapshot unavailable: {}", snapshot.file_path))?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        self.apply_restore(project, &repo, files, "Before Rollback")
    }

    fn apply_restore(
        &self,
        project: &Path,
        repo: &HistoryFileRepository,
        files: Vec<RestoreFile>,
        label_name: &str,
    ) -> Result<Vec<String>> {
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let root = project
            .canonicalize()
            .context("Failed to resolve project directory")?;
        let current = files
            .iter()
            .map(|file| {
                let target = restore_path(&root, &file.relative)?;
                read_current(&target)
            })
            .collect::<Result<Vec<_>>>()?;
        save_backup(
            repo,
            &files,
            &current,
            label_name,
            &Self::read_current_branch(project).unwrap_or_default(),
        )?;
        let mut restored = Vec::new();
        for file in files {
            let target = restore_path(&root, &file.relative)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let target = restore_path(&root, &file.relative)?;
            write_atomic(&target, &file.content).with_context(|| {
                format!(
                    "Failed to restore {}; previous state is in {label_name}",
                    file.relative
                )
            })?;
            restored.push(file.relative);
        }
        Ok(restored)
    }
}

fn read_current(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("Failed to back up {}", path.display())),
    }
}

fn save_backup(
    repo: &HistoryFileRepository,
    files: &[RestoreFile],
    current: &[Option<Vec<u8>>],
    name: &str,
    branch: &str,
) -> Result<()> {
    let mut snapshots = Vec::with_capacity(files.len());
    for (file, content) in files.iter().zip(current) {
        let version = repo.save_restore_backup(&file.relative, content.as_deref(), branch)?;
        snapshots.push(LabelFileSnapshot {
            file_path: file.relative.clone(),
            version_id: version.id,
        });
    }
    repo.put_label(&HistoryLabel {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        label_type: "auto".into(),
        source: "restore".into(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        file_snapshots: snapshots,
        branch: branch.into(),
    })
    .context("Failed to save restore backup label")
}

/// Validate existing ancestors too: a missing leaf beneath an escaping symlink
/// must be rejected before create_dir_all or any backup/write occurs.
fn restore_path(root: &Path, relative: &str) -> Result<PathBuf> {
    ensure!(
        !relative.is_empty() && !relative.contains(['\\', ':']),
        "Invalid history path: {relative}"
    );
    let mut target = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(name) = component else {
            bail!("Invalid history path: {relative}");
        };
        target.push(name);
        match fs::symlink_metadata(&target) {
            Ok(_) => {
                target = target
                    .canonicalize()
                    .with_context(|| format!("Cannot resolve history path: {relative}"))?;
                ensure!(
                    target.starts_with(root),
                    "History path escapes project: {relative}"
                );
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Cannot inspect history path: {relative}"))
            }
        }
    }
    ensure!(
        target != root && !target.is_dir(),
        "History target is not a file: {relative}"
    );
    Ok(target)
}
