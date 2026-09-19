//! Bounded completed-session output, independent of the five-minute memory cache.
//! The dedicated directory avoids pruning files owned by session restore/checkpoints.

use crate::utils::AppPaths;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_FILES: usize = 128;
const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct ArchiveOutput {
    pub(super) lines: Vec<String>,
    pub(super) exit_code: Option<i32>,
}

static ARCHIVE_WRITE: Mutex<()> = Mutex::new(());

fn safe_id(id: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')),
        "Invalid terminal session id"
    );
    Ok(())
}

fn directory(paths: &AppPaths) -> PathBuf {
    paths.data_dir().join("terminal-output")
}

fn check_directory(dir: &Path) -> anyhow::Result<()> {
    match fs::symlink_metadata(dir) {
        Ok(meta) => anyhow::ensure!(
            meta.file_type().is_dir(),
            "Output directory must not be a symlink or file"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn bounded_body(lines: &[String], max_bytes: usize) -> Vec<u8> {
    let mut remaining = max_bytes;
    let mut tail = Vec::new();
    for line in lines.iter().rev() {
        if remaining == 0 {
            break;
        }
        let available = remaining.saturating_sub(1);
        let mut start = line.len().saturating_sub(available);
        while !line.is_char_boundary(start) {
            start += 1;
        }
        let line = &line[start..];
        remaining -= line.len() + 1;
        tail.push(line);
        if start > 0 {
            break;
        }
    }
    let mut body = Vec::with_capacity(max_bytes - remaining);
    for line in tail.into_iter().rev() {
        body.extend_from_slice(line.as_bytes());
        body.push(b'\n');
    }
    body
}

pub(super) fn persist(
    paths: &AppPaths,
    id: &str,
    lines: &[String],
    exit_code: Option<i32>,
) -> anyhow::Result<()> {
    safe_id(id)?;
    let _guard = ARCHIVE_WRITE
        .lock()
        .map_err(|_| anyhow::anyhow!("output archive lock poisoned"))?;
    let dir = directory(paths);
    check_directory(&dir)?;
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{id}.output"));
    match fs::symlink_metadata(&path) {
        Ok(meta) => anyhow::ensure!(
            meta.file_type().is_file(),
            "Output archive must be a regular file"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    // A simultaneous explicit kill must not replace the waiter's final snapshot.
    if exit_code.is_none() {
        if let Some(previous) = read(paths, id, 1)? {
            if previous.exit_code.is_some() {
                return Ok(());
            }
        }
    }
    // JSON escaping is at most six bytes per input byte; cap the serialized file too.
    let body = bounded_body(lines, (MAX_FILE_BYTES - 1024) / 6);
    let lines = String::from_utf8(body)?
        .lines()
        .map(str::to_string)
        .collect();
    let output = ArchiveOutput { lines, exit_code };
    let body = serde_json::to_vec(&output)?;
    anyhow::ensure!(body.len() <= MAX_FILE_BYTES, "output archive exceeds bound");
    write_atomic(&path, &body)?;
    prune(&dir, SystemTime::now(), MAX_FILES, MAX_TOTAL_BYTES, MAX_AGE)
}

fn write_atomic(path: &Path, body: &[u8]) -> anyhow::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> anyhow::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(body)?;
        file.sync_all()?;
        drop(file);
        // std::fs::rename replaces files atomically on Windows and Unix. If it
        // fails, preserve the old archive; never delete it to force a retry.
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        if let Err(error) = fs::remove_file(&temporary) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, "failed to remove archive temporary file");
            }
        }
    }
    result
}

fn prune(
    dir: &Path,
    now: SystemTime,
    max_files: usize,
    max_bytes: u64,
    age: Duration,
) -> anyhow::Result<()> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        if entry.path().extension().is_some_and(|ext| ext == "tmp") {
            if now
                .duration_since(entry.metadata()?.modified()?)
                .unwrap_or_default()
                > Duration::from_secs(300)
            {
                fs::remove_file(entry.path())?;
            }
            continue;
        }
        if entry.path().extension().is_none_or(|ext| ext != "output") {
            continue;
        }
        let metadata = entry.metadata()?;
        let modified = metadata.modified()?;
        if now.duration_since(modified).unwrap_or_default() > age {
            fs::remove_file(entry.path())?;
        } else {
            files.push((modified, entry.path(), metadata.len()));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut total = 0;
    for (i, (_, path, size)) in files.into_iter().enumerate() {
        total += size;
        if i >= max_files || total > max_bytes {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

pub(super) fn read(paths: &AppPaths, id: &str, n: usize) -> anyhow::Result<Option<ArchiveOutput>> {
    safe_id(id)?;
    check_directory(&directory(paths))?;
    let archive = directory(paths).join(format!("{id}.output"));
    if let Some(lines) = read_file(&archive, 0, Some(MAX_AGE))? {
        let mut output: ArchiveOutput = serde_json::from_str(&lines.join("\n"))?;
        if n > 0 && output.lines.len() > n {
            output.lines.drain(..output.lines.len() - n);
        }
        return Ok(Some(output));
    }
    // Old files prove retention only. They contain no OS process completion evidence.
    check_directory(&paths.sessions_dir())?;
    Ok(
        read_file(&paths.session_output_path(id), n, None)?.map(|lines| ArchiveOutput {
            lines,
            exit_code: None,
        }),
    )
}

fn read_file(
    path: &Path,
    n: usize,
    max_age: Option<Duration>,
) -> anyhow::Result<Option<Vec<String>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(
        metadata.file_type().is_file(),
        "Terminal output archive is not a regular file"
    );
    if max_age.is_some_and(|age| {
        metadata
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .is_some_and(|elapsed| elapsed > age)
    }) {
        return Ok(None);
    }
    if max_age.is_some() {
        anyhow::ensure!(
            metadata.len() <= MAX_FILE_BYTES as u64,
            "Oversized output archive"
        );
    }
    let mut file = fs::File::open(path)?;
    let offset = metadata.len().saturating_sub(MAX_FILE_BYTES as u64);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES as u64).read_to_end(&mut bytes)?;
    // Drop an incomplete first line when tail-reading an older oversized file.
    let start = if offset > 0 {
        bytes
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |i| i + 1)
    } else {
        0
    };
    let text = String::from_utf8(bytes[start..].to_vec())?;
    let mut lines: Vec<_> = text.lines().map(str::to_string).collect();
    if n > 0 && lines.len() > n {
        lines.drain(..lines.len() - n);
    }
    Ok(Some(lines))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue64_archive_prunes_by_count_size_and_age_without_touching_checkpoints() {
        let dir = tempfile::tempdir().unwrap();
        for id in 0..5 {
            fs::write(dir.path().join(format!("{id}.output")), b"12345").unwrap();
        }
        fs::write(dir.path().join("keep.checkpoint.json"), b"keep").unwrap();
        prune(dir.path(), SystemTime::now(), 3, 10, MAX_AGE).unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3); // two output + checkpoint
        prune(
            dir.path(),
            SystemTime::now() + MAX_AGE + Duration::from_secs(1),
            3,
            10,
            MAX_AGE,
        )
        .unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn issue64_archive_bounds_utf8_and_rejects_path_traversal() {
        let body = bounded_body(&["old".into(), "好".repeat(100)], 11);
        assert!(body.len() <= 11);
        assert_eq!(String::from_utf8(body).unwrap(), "好好好\n");
        for id in ["../secrets", "..", "C:\\file", "s/id", ""] {
            assert!(safe_id(id).is_err());
        }
    }

    #[test]
    fn issue64_archive_reads_only_tail_of_legacy_output() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.output");
        fs::write(
            &path,
            format!("{}\nfirst\nlast\n", "x".repeat(MAX_FILE_BYTES + 100)),
        )
        .unwrap();
        assert_eq!(read_file(&path, 1, None).unwrap().unwrap(), ["last"]);
    }

    #[test]
    fn issue64_archive_write_failure_is_reported_and_leaves_previous_output() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(Some(dir.path().to_string_lossy().into_owned()));
        persist(&paths, "saved", &["stable".into()], Some(0)).unwrap();
        // A directory occupying a file path is a deterministic write failure on every OS.
        fs::create_dir(directory(&paths).join("blocked.output")).unwrap();
        assert!(persist(&paths, "blocked", &["lost".into()], Some(0)).is_err());
        assert_eq!(read(&paths, "saved", 0).unwrap().unwrap().lines, ["stable"]);
        assert!(read(&paths, "blocked", 0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn issue64_archive_rejects_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(Some(dir.path().to_string_lossy().into_owned()));
        fs::create_dir_all(directory(&paths)).unwrap();
        let outside = dir.path().join("outside");
        fs::write(&outside, "private").unwrap();
        std::os::unix::fs::symlink(&outside, directory(&paths).join("link.output")).unwrap();
        assert!(read(&paths, "link", 0).is_err());
        assert!(persist(&paths, "link", &["overwrite".into()], Some(0)).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "private");
    }
}
