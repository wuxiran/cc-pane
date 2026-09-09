use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub(super) const FILE_BYTES: u64 = 8 * 1024 * 1024;
pub(super) const FILE_COUNT: usize = 8;
const RECORD_BYTES: usize = 64 * 1024;

pub(super) struct RingLog {
    directory: PathBuf,
    file: Option<File>,
    bytes: u64,
    limit: u64,
    count: usize,
}

impl RingLog {
    pub(super) fn new(directory: &Path, limit: u64, count: usize) -> io::Result<Self> {
        fs::create_dir_all(directory)?;
        let mut log = Self {
            directory: directory.into(),
            file: None,
            bytes: 0,
            limit,
            count,
        };
        log.open()?;
        Ok(log)
    }
    fn path(&self, index: usize) -> PathBuf {
        self.directory.join(if index == 0 {
            "performance.jsonl".into()
        } else {
            format!("performance.{index}.jsonl")
        })
    }
    fn open(&mut self) -> io::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(self.path(0))?;
        self.bytes = file.metadata()?.len();
        if self.bytes > 0 && self.bytes < self.limit {
            file.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            file.read_exact(&mut last)?;
            if last[0] != b'\n' {
                file.write_all(b"\n")?;
                self.bytes += 1;
            }
        }
        self.file = Some(file);
        Ok(())
    }
    fn rotate(&mut self) -> io::Result<()> {
        self.file.take(); // Windows requires the writer closed before renaming.
        let oldest = self.path(self.count - 1);
        if oldest.exists() {
            fs::remove_file(oldest)?;
        }
        for index in (0..self.count - 1).rev() {
            let source = self.path(index);
            if source.exists() {
                fs::rename(source, self.path(index + 1))?;
            }
        }
        self.open()
    }
    pub(super) fn append(&mut self, value: &serde_json::Value) -> io::Result<()> {
        let mut data = serde_json::to_vec(value)?;
        data.push(b'\n');
        if data.len() > RECORD_BYTES || data.len() as u64 > self.limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "diagnostic record exceeds limit",
            ));
        }
        if self.file.is_none() {
            self.open()?;
        }
        if self.bytes + data.len() as u64 > self.limit {
            self.rotate()?;
        }
        if let Err(error) = self.file.as_mut().expect("writer opened").write_all(&data) {
            self.bytes = self.file.as_ref().expect("writer opened").metadata()?.len();
            return Err(error);
        }
        self.file.as_mut().expect("writer opened").flush()?;
        self.bytes += data.len() as u64;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reopening_after_a_crash_does_not_merge_the_next_record_into_a_partial_line() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("performance.jsonl");
        fs::write(&path, b"{partial").unwrap();
        let mut log = RingLog::new(directory.path(), 128, 3).unwrap();
        log.append(&serde_json::json!({"boot":2})).unwrap();
        let contents = fs::read_to_string(path).unwrap();
        let lines: Vec<_> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[1]).unwrap()["boot"],
            2
        );
    }
    #[test]
    fn rotation_preserves_valid_lines_and_bounds_total_disk_usage() {
        let directory = tempfile::tempdir().unwrap();
        let mut log = RingLog::new(directory.path(), 128, 3).unwrap();
        for i in 0..100 {
            log.append(&serde_json::json!({"sample": i})).unwrap();
        }
        drop(log);
        let files: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(files.len(), 3);
        assert!(
            files
                .iter()
                .map(|f| f.metadata().unwrap().len())
                .sum::<u64>()
                <= 384
        );
        for file in files {
            for line in fs::read_to_string(file.path()).unwrap().lines() {
                serde_json::from_str::<serde_json::Value>(line).unwrap();
            }
        }
        assert!(
            fs::read_to_string(directory.path().join("performance.jsonl"))
                .unwrap()
                .contains("99")
        );
        let mut reopened = RingLog::new(directory.path(), 128, 3).unwrap();
        reopened.append(&serde_json::json!({"boot":2})).unwrap();
    }
    #[test]
    fn oversize_record_is_rejected_without_growing_files() {
        let directory = tempfile::tempdir().unwrap();
        let mut log = RingLog::new(directory.path(), 128, 3).unwrap();
        assert!(log
            .append(&serde_json::json!({"x":"a".repeat(200)}))
            .is_err());
        assert_eq!(
            fs::metadata(directory.path().join("performance.jsonl"))
                .unwrap()
                .len(),
            0
        );
    }
}
