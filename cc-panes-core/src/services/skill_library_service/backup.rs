//! 被替换 / 删除的技能目录移到 `<data>/backups/skills/<YYYYMMDD-HHMMSS>/<id>/`，
//! 只保留最近 30 个时间目录。

use super::fs_ops::move_dir;
use crate::utils::AppResult;
use std::path::{Path, PathBuf};
use tracing::warn;

pub(crate) const BACKUP_RETENTION: usize = 30;

/// 一次操作（一次 update / remove 调用）共用一个时间目录，第一次用到时才创建。
pub(crate) struct BackupSession {
    root: PathBuf,
    dir: Option<PathBuf>,
}

fn is_backup_dir_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 15
        && bytes[8] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 8 || byte.is_ascii_digit())
}

impl BackupSession {
    pub(crate) fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            dir: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    fn ensure_dir(&mut self) -> AppResult<PathBuf> {
        if let Some(dir) = &self.dir {
            return Ok(dir.clone());
        }
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let dir = self.root.join(stamp);
        std::fs::create_dir_all(&dir)?;
        self.dir = Some(dir.clone());
        Ok(dir)
    }

    /// 把 `source` 移进备份，返回新位置。同一时间目录里重名时追加序号。
    pub(crate) fn stash(&mut self, id: &str, source: &Path) -> AppResult<PathBuf> {
        let dir = self.ensure_dir()?;
        let mut target = dir.join(id);
        let mut suffix = 1;
        while target.exists() {
            target = dir.join(format!("{}-{}", id, suffix));
            suffix += 1;
        }
        move_dir(source, &target)?;
        Ok(target)
    }

    /// 结束本次操作：按名字（即时间）只保留最近 `BACKUP_RETENTION` 个时间目录。
    pub(crate) fn finish(self) -> Option<String> {
        let dir = self.dir.as_ref()?.to_string_lossy().to_string();
        prune_backups(&self.root, BACKUP_RETENTION);
        Some(dir)
    }
}

pub(crate) fn prune_backups(root: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| is_backup_dir_name(name))
        .collect();
    if names.len() <= keep {
        return;
    }
    names.sort();
    let excess = names.len() - keep;
    for name in names.into_iter().take(excess) {
        if let Err(error) = std::fs::remove_dir_all(root.join(&name)) {
            warn!("[skill_library] failed to prune backup {}: {}", name, error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_moves_into_timestamp_dir_and_avoids_collisions() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("backups");
        let mut session = BackupSession::new(&root);
        assert!(session.dir().is_none());

        for _ in 0..2 {
            let source = tmp.path().join("skill");
            std::fs::create_dir_all(&source).unwrap();
            std::fs::write(source.join("SKILL.md"), "x").unwrap();
            session.stash("pdf", &source).unwrap();
            assert!(!source.exists());
        }
        let dir = session.dir().unwrap().to_path_buf();
        assert!(is_backup_dir_name(
            &dir.file_name().unwrap().to_string_lossy()
        ));
        assert!(dir.join("pdf/SKILL.md").is_file());
        assert!(dir.join("pdf-1/SKILL.md").is_file());
        assert_eq!(session.finish(), Some(dir.to_string_lossy().to_string()));
    }

    #[test]
    fn prune_keeps_the_newest_thirty_and_ignores_foreign_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for day in 1..=35 {
            std::fs::create_dir_all(root.join(format!("202611{:02}-120000", day % 31 + 1)))
                .unwrap();
            std::fs::create_dir_all(root.join(format!("202612{:02}-120000", day))).unwrap();
        }
        std::fs::create_dir_all(root.join("keep-me")).unwrap();
        prune_backups(root, BACKUP_RETENTION);
        let mut left: Vec<String> = std::fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(left.len(), BACKUP_RETENTION + 1);
        assert!(left.contains(&"keep-me".to_string()));
        assert!(left.contains(&"20261235-120000".to_string()));
        assert!(!left.iter().any(|name| name.starts_with("202611")));
    }

    #[test]
    fn finish_without_stash_creates_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("backups");
        assert_eq!(BackupSession::new(&root).finish(), None);
        assert!(!root.exists());
    }
}
