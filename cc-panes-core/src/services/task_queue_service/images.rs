use super::{TaskQueueService, TASK_QUEUE_IMAGE_MAX_BYTES};
use crate::models::task_queue::{StagedTaskQueueImage, TaskQueueItem};
use crate::utils::error::{AppError, AppResult};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};
use uuid::Uuid;

/// Orphaned/completed attachments remain readable for seven days after last submission.
/// Explicit session exit releases unreferenced files earlier; queued references never expire.
pub const TASK_QUEUE_IMAGE_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const TASK_QUEUE_IMAGE_STORAGE_MAX_BYTES: u64 = 1024 * 1024 * 1024;
const TASK_QUEUE_IMAGE_STORAGE_MAX_FILES: usize = 4096;

impl TaskQueueService {
    pub fn stage_image(
        &self,
        session_id: &str,
        source: &Path,
        width: u32,
        height: u32,
    ) -> AppResult<StagedTaskQueueImage> {
        let _guard = self
            .image_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if width == 0 || height == 0 {
            return Err(image_error("Clipboard image dimensions must be non-zero"));
        }
        reject_link_or_reparse(source)?;
        let trusted_root = self
            .trusted_source_root
            .canonicalize()
            .map_err(|_| image_error("Trusted clipboard image directory is unavailable"))?;
        let source = source
            .canonicalize()
            .map_err(|_| image_error("Clipboard image is unavailable"))?;
        if !source.starts_with(&trusted_root) {
            return Err(image_error(
                "Clipboard image is outside the trusted directory",
            ));
        }
        let metadata = source
            .metadata()
            .map_err(|_| image_error("Clipboard image metadata is unavailable"))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > TASK_QUEUE_IMAGE_MAX_BYTES
        {
            return Err(image_error(
                "Clipboard image has an invalid size or file type",
            ));
        }
        let extension = detect_image_extension(&source)?;
        self.prune_images_locked(SystemTime::now())?;
        self.check_image_storage_budget(metadata.len())?;

        std::fs::create_dir_all(&self.image_root)
            .map_err(|e| stage_error(format!("Failed to create image directory: {e}")))?;
        reject_link_or_reparse(&self.image_root)?;
        let session_dir = self.session_image_dir(session_id);
        std::fs::create_dir_all(&session_dir)
            .map_err(|e| stage_error(format!("Failed to create session image directory: {e}")))?;
        reject_link_or_reparse(&session_dir)?;

        let image_ref = format!("{}.{}", Uuid::new_v4(), extension);
        let destination = session_dir.join(&image_ref);
        let temporary = session_dir.join(format!(".{image_ref}.tmp"));
        let copied = std::fs::copy(&source, &temporary)
            .map_err(|e| stage_error(format!("Failed to stage clipboard image: {e}")))?;
        if copied != metadata.len() {
            let _ = std::fs::remove_file(&temporary);
            return Err(stage_error("Clipboard image copy was incomplete"));
        }
        std::fs::rename(&temporary, &destination).map_err(|e| {
            let _ = std::fs::remove_file(&temporary);
            stage_error(format!("Failed to publish staged clipboard image: {e}"))
        })?;
        self.resolve_image_ref(session_id, &image_ref)?;
        Ok(StagedTaskQueueImage {
            image_ref,
            width,
            height,
        })
    }

    pub fn effective_prompt(&self, session_id: &str, item: &TaskQueueItem) -> AppResult<String> {
        let _guard = self
            .image_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if item.session_id != session_id {
            return Err(AppError::coded(
                "IMAGE_REF_INVALID",
                "Queued task belongs to another terminal session",
            ));
        }
        let paths = item
            .image_refs
            .iter()
            .map(|image_ref| {
                let path = self.resolve_image_ref(session_id, image_ref)?;
                // A sidecar lease avoids changing image bytes/permissions and works with
                // read-only clipboard sources. Refresh before any possible terminal write.
                retain_submitted_image(&path)?;
                Ok(path.to_string_lossy().into_owned())
            })
            .collect::<AppResult<Vec<_>>>()?;
        Ok(Self::compose_prompt(&paths, &item.text))
    }

    pub fn compose_prompt(image_paths: &[String], text: &str) -> String {
        let image_part = image_paths.join(" ");
        let text = text.trim();
        match (image_part.is_empty(), text.is_empty()) {
            (false, false) => format!("{image_part}\n{text}"),
            (false, true) => image_part,
            (true, false) => text.to_string(),
            (true, true) => String::new(),
        }
    }

    pub fn resolve_image_ref(&self, session_id: &str, image_ref: &str) -> AppResult<PathBuf> {
        validate_opaque_ref(image_ref)?;
        let session_dir = self.session_image_dir(session_id);
        let canonical_dir = session_dir
            .canonicalize()
            .map_err(|_| image_error("Staged image directory is unavailable"))?;
        reject_link_or_reparse(&canonical_dir)?;
        let path = session_dir.join(image_ref);
        reject_link_or_reparse(&path)?;
        let canonical_path = path
            .canonicalize()
            .map_err(|_| image_error("Staged image reference does not exist"))?;
        if !canonical_path.starts_with(&canonical_dir) {
            return Err(image_error(
                "Staged image reference escapes its session directory",
            ));
        }
        let metadata = canonical_path
            .metadata()
            .map_err(|_| image_error("Staged image metadata is unavailable"))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > TASK_QUEUE_IMAGE_MAX_BYTES
        {
            return Err(image_error("Staged image has an invalid size or file type"));
        }
        let detected_extension = detect_image_extension(&canonical_path)?;
        let declared_extension = Path::new(image_ref)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if declared_extension != detected_extension {
            return Err(image_error(
                "Staged image content does not match its declared format",
            ));
        }
        Ok(canonical_path)
    }

    pub fn prune_unreferenced_images(&self) -> AppResult<usize> {
        self.prune_unreferenced_images_at(SystemTime::now())
    }

    #[doc(hidden)]
    pub fn prune_unreferenced_images_at(&self, now: SystemTime) -> AppResult<usize> {
        let _guard = self
            .image_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.prune_images_locked(now)
    }

    /// Call only after an explicit terminal-exit observation, not a failed backend lookup.
    /// Pending/failed/delivery-unknown queue items keep their attachments for user recovery.
    pub fn release_session_images(&self, session_id: &str) -> AppResult<usize> {
        let _guard = self
            .image_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let directory = self.session_image_dir(session_id);
        if !directory.exists() {
            return Ok(0);
        }
        let referenced = self.referenced_image_paths()?;
        let files = image_files_in_directory(&directory)?;
        let removed = remove_unreferenced_images(&files, &referenced, None)?;
        let _ = std::fs::remove_dir(directory); // Only succeeds when no retained files remain.
        Ok(removed)
    }

    fn prune_images_locked(&self, now: SystemTime) -> AppResult<usize> {
        let referenced = self.referenced_image_paths()?;
        remove_unreferenced_images(&self.all_image_files()?, &referenced, Some(now))
    }

    fn referenced_image_paths(&self) -> AppResult<HashSet<PathBuf>> {
        let mut referenced = HashSet::new();
        for session_id in self.repository.active_session_ids()? {
            let snapshot = self.repository.snapshot(&session_id)?;
            for image_ref in snapshot.items.iter().flat_map(|item| &item.image_refs) {
                // Retain even a temporarily corrupt attachment while a queued item refers
                // to it; only the queue owner may decide to remove that task.
                validate_opaque_ref(image_ref)?;
                let path = self.session_image_dir(&session_id).join(image_ref);
                if let Ok(path) = path.canonicalize() {
                    referenced.insert(path);
                }
            }
        }
        Ok(referenced)
    }

    fn all_image_files(&self) -> AppResult<Vec<PathBuf>> {
        if !self.image_root.exists() {
            return Ok(Vec::new());
        }
        reject_link_or_reparse(&self.image_root)?;
        let mut files = Vec::new();
        for directory in std::fs::read_dir(&self.image_root)? {
            let directory = directory?;
            reject_link_or_reparse(&directory.path())?;
            if directory.file_type()?.is_dir() {
                files.extend(image_files_in_directory(&directory.path())?);
                let _ = std::fs::remove_dir(directory.path()); // Empty orphan directory only.
            }
        }
        Ok(files)
    }

    fn check_image_storage_budget(&self, incoming: u64) -> AppResult<()> {
        let files = self.all_image_files()?;
        let used = files.iter().try_fold(0u64, |bytes, file| {
            file.metadata()
                .map(|metadata| bytes.saturating_add(metadata.len()))
        })?;
        // Reserve room for the lease next to every staged image. Never evict a queued
        // or recently submitted attachment to make space for a new paste.
        let images = files.iter().filter(|path| !is_image_lease(path)).count();
        if used
            .saturating_add(incoming)
            .saturating_add(8 * (images as u64 + 1))
            > TASK_QUEUE_IMAGE_STORAGE_MAX_BYTES
            || images >= TASK_QUEUE_IMAGE_STORAGE_MAX_FILES
        {
            return Err(stage_error("Task queue image storage is full (1 GiB / 4096 images); finish sessions or wait for expired attachments to be cleaned"));
        }
        Ok(())
    }

    fn session_image_dir(&self, session_id: &str) -> PathBuf {
        let digest = Sha256::digest(session_id.as_bytes());
        self.image_root.join(format!("{digest:x}"))
    }
}

fn image_files_in_directory(directory: &Path) -> AppResult<Vec<PathBuf>> {
    reject_link_or_reparse(directory)?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        reject_link_or_reparse(&entry.path())?;
        if entry.file_type()?.is_file() {
            files.push(entry.path().canonicalize()?);
        }
    }
    Ok(files)
}

fn retain_submitted_image(image: &Path) -> AppResult<()> {
    let temporary = image.with_file_name(format!(".{}.lease", Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(b"retained")?;
        drop(file);
        // Replace the marker atomically; never follow an existing symlink/hardlink.
        std::fs::rename(&temporary, image_lease_path(image))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|error| stage_error(format!("Failed to retain submitted image: {error}")))
}

fn image_lease_path(image: &Path) -> PathBuf {
    let mut name = image.as_os_str().to_os_string();
    name.push(".lease");
    PathBuf::from(name)
}

fn is_image_lease(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "lease")
}

fn remove_unreferenced_images(
    files: &[PathBuf],
    referenced: &HashSet<PathBuf>,
    now: Option<SystemTime>,
) -> AppResult<usize> {
    let mut removed = 0;
    for path in files.iter().filter(|path| !is_image_lease(path)) {
        if referenced.contains(path) {
            continue;
        }
        let lease = image_lease_path(path);
        if let Some(now) = now {
            let modified = path.metadata()?.modified()?;
            let retained_at = if lease.exists() {
                reject_link_or_reparse(&lease)?;
                modified.max(lease.metadata()?.modified()?)
            } else {
                modified
            };
            if !now
                .duration_since(retained_at)
                .is_ok_and(|age| age >= TASK_QUEUE_IMAGE_RETENTION)
            {
                continue;
            }
        }
        std::fs::remove_file(path)?;
        if lease.exists() {
            std::fs::remove_file(lease)?;
        }
        removed += 1;
    }
    // Orphaned lease files contain no user content and have no remaining consumer.
    for lease in files.iter().filter(|path| is_image_lease(path)) {
        let image = lease.with_extension("");
        if lease.exists() && !image.exists() {
            std::fs::remove_file(lease)?;
        }
    }
    Ok(removed)
}

fn validate_opaque_ref(image_ref: &str) -> AppResult<()> {
    let path = Path::new(image_ref);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(image_error(
            "Image reference is not an opaque file identifier",
        ));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "webp") {
        return Err(image_error("Image reference uses an unsupported format"));
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    Uuid::parse_str(stem).map_err(|_| image_error("Image reference is not valid"))?;
    Ok(())
}

fn detect_image_extension(path: &Path) -> AppResult<&'static str> {
    let mut file = File::open(path).map_err(|_| image_error("Image data cannot be read"))?;
    let mut header = [0_u8; 12];
    let read = file
        .read(&mut header)
        .map_err(|_| image_error("Image data cannot be read"))?;
    if read >= 8 && header[..8] == *b"\x89PNG\r\n\x1a\n" {
        return Ok("png");
    }
    if read >= 3 && header[..3] == [0xff, 0xd8, 0xff] {
        return Ok("jpg");
    }
    if read >= 12 && header[..4] == *b"RIFF" && header[8..12] == *b"WEBP" {
        return Ok("webp");
    }
    Err(image_error("Image data is not PNG, JPEG, or WebP"))
}

fn reject_link_or_reparse(path: &Path) -> AppResult<()> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| image_error("Image path metadata is unavailable"))?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(image_error("Image paths cannot be links or reparse points"));
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn image_error(message: impl Into<String>) -> AppError {
    AppError::coded("IMAGE_REF_INVALID", message)
}

fn stage_error(message: impl Into<String>) -> AppError {
    AppError::coded("IMAGE_STAGE_FAILED", message)
}
