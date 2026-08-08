use crate::models::filesystem::{DirListing, FileContent, FsEntry, ImageFileContent};
use crate::models::ssh_machine::AuthMethod;
use crate::services::{SshConnectionService, SshMachineService};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use ssh2::{Session, Sftp};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_TEXT_FILE_SIZE: u64 = 5 * 1024 * 1024;
const MAX_IMAGE_FILE_SIZE: u64 = 20 * 1024 * 1024;

pub struct SshFileService {
    machine_service: Arc<SshMachineService>,
    connection_service: Arc<SshConnectionService>,
    connections: Mutex<HashMap<String, Arc<Mutex<SftpConnection>>>>,
}

struct SftpConnection {
    session: Session,
    sftp: Sftp,
    machine_updated_at: String,
}

impl SshFileService {
    pub fn new(
        machine_service: Arc<SshMachineService>,
        connection_service: Arc<SshConnectionService>,
    ) -> Self {
        Self {
            machine_service,
            connection_service,
            connections: Mutex::new(HashMap::new()),
        }
    }

    pub fn configure_password(
        &self,
        machine_id: &str,
        password: &str,
        remember: bool,
    ) -> Result<()> {
        let machine = self
            .machine_service
            .get(machine_id)
            .with_context(|| format!("SSH machine '{}' not found", machine_id))?;
        if machine.auth_method != AuthMethod::Password {
            bail!(
                "SSH machine '{}' does not use password authentication",
                machine_id
            );
        }
        if password.is_empty() {
            bail!("SSH password cannot be empty");
        }

        self.machine_service
            .store_temporary_password(machine_id, password)?;
        self.disconnect_machine(machine_id);
        if let Err(error) = self.connect(machine_id) {
            self.machine_service.clear_temporary_password(machine_id);
            return Err(error);
        }
        if remember {
            self.machine_service.store_password(machine_id, password)?;
        }
        Ok(())
    }

    pub fn list_directory(
        &self,
        machine_id: &str,
        path: &str,
        show_hidden: bool,
    ) -> Result<DirListing> {
        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let resolved = resolve_remote_path(&connection.sftp, path)?;
        let mut entries = connection
            .sftp
            .readdir(&resolved)
            .with_context(|| {
                format!(
                    "Failed to list remote directory {}",
                    display_path(&resolved)
                )
            })?
            .into_iter()
            .filter_map(|(path, stat)| {
                let name = path.file_name()?.to_string_lossy().into_owned();
                if !show_hidden && name.starts_with('.') {
                    return None;
                }
                let is_dir = stat.is_dir();
                let is_file = stat.is_file();
                let is_symlink = stat.file_type().is_symlink();
                Some(FsEntry {
                    extension: if is_file {
                        Path::new(&name)
                            .extension()
                            .map(|value| value.to_string_lossy().to_ascii_lowercase())
                    } else {
                        None
                    },
                    hidden: name.starts_with('.'),
                    modified: stat.mtime.and_then(format_timestamp),
                    name,
                    path: display_path(&path),
                    is_dir,
                    is_file,
                    is_symlink,
                    size: stat.size.unwrap_or(0),
                    permissions: stat.perm.map(format_permissions),
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            right
                .is_dir
                .cmp(&left.is_dir)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });

        Ok(DirListing {
            path: display_path(&resolved),
            entries,
        })
    }

    pub fn read_file(&self, machine_id: &str, path: &str) -> Result<FileContent> {
        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let resolved = resolve_remote_path(&connection.sftp, path)?;
        let stat = connection.sftp.stat(&resolved).with_context(|| {
            format!("Failed to inspect remote file {}", display_path(&resolved))
        })?;
        let size = stat.size.unwrap_or(0);
        if size > MAX_TEXT_FILE_SIZE {
            bail!("Remote file is too large to edit (maximum 5 MB)");
        }

        let mut file = connection
            .sftp
            .open(&resolved)
            .with_context(|| format!("Failed to open remote file {}", display_path(&resolved)))?;
        let mut bytes = Vec::with_capacity(size as usize);
        file.read_to_end(&mut bytes)
            .with_context(|| format!("Failed to read remote file {}", display_path(&resolved)))?;
        let content = String::from_utf8(bytes)
            .with_context(|| "Remote file is not UTF-8 text and cannot be edited here")?;
        let canonical_path = display_path(&resolved);

        Ok(FileContent {
            path: canonical_path.clone(),
            size: content.len() as u64,
            content,
            encoding: "utf-8".to_string(),
            language: language_from_path(&canonical_path),
        })
    }

    pub fn read_image(&self, machine_id: &str, path: &str) -> Result<ImageFileContent> {
        let mime_type = image_mime_type(path)
            .with_context(|| "Remote file type is not supported for image preview")?;
        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let resolved = resolve_remote_path(&connection.sftp, path)?;
        let stat = connection.sftp.stat(&resolved).with_context(|| {
            format!("Failed to inspect remote image {}", display_path(&resolved))
        })?;
        let size = stat.size.unwrap_or(0);
        if size > MAX_IMAGE_FILE_SIZE {
            bail!("Remote image is too large to preview (maximum 20 MB)");
        }

        let mut file = connection
            .sftp
            .open(&resolved)
            .with_context(|| format!("Failed to open remote image {}", display_path(&resolved)))?;
        let mut bytes = Vec::with_capacity(size as usize);
        file.read_to_end(&mut bytes)
            .with_context(|| format!("Failed to read remote image {}", display_path(&resolved)))?;

        Ok(ImageFileContent {
            path: display_path(&resolved),
            size: bytes.len() as u64,
            data_base64: STANDARD.encode(bytes),
            mime_type: mime_type.to_string(),
        })
    }

    pub fn write_file(&self, machine_id: &str, path: &str, content: &str) -> Result<()> {
        if content.len() as u64 > MAX_TEXT_FILE_SIZE {
            bail!("Remote file is too large to save (maximum 5 MB)");
        }
        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let resolved = resolve_remote_path(&connection.sftp, path)?;
        let mut file = connection.sftp.create(&resolved).with_context(|| {
            format!(
                "Failed to open remote file {} for writing",
                display_path(&resolved)
            )
        })?;
        file.write_all(content.as_bytes())
            .with_context(|| format!("Failed to write remote file {}", display_path(&resolved)))?;
        file.flush().context("Failed to flush remote file")?;
        Ok(())
    }

    pub fn create_file(&self, machine_id: &str, parent: &str, name: &str) -> Result<()> {
        validate_entry_name(name)?;
        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let parent = resolve_remote_path(&connection.sftp, parent)?;
        let path = join_remote_path(&parent, name);
        connection
            .sftp
            .create(&path)
            .with_context(|| format!("Failed to create remote file {}", display_path(&path)))?;
        Ok(())
    }

    pub fn create_directory(&self, machine_id: &str, parent: &str, name: &str) -> Result<()> {
        validate_entry_name(name)?;
        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let parent = resolve_remote_path(&connection.sftp, parent)?;
        let path = join_remote_path(&parent, name);
        connection
            .sftp
            .mkdir(&path, 0o755)
            .with_context(|| format!("Failed to create remote directory {}", display_path(&path)))
    }

    pub fn rename_entry(&self, machine_id: &str, path: &str, new_name: &str) -> Result<()> {
        validate_entry_name(new_name)?;
        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let source = resolve_remote_path(&connection.sftp, path)?;
        let parent = parent_remote_path(&source).context("Remote entry has no parent directory")?;
        let destination = join_remote_path(&parent, new_name);
        connection
            .sftp
            .rename(&source, &destination, None)
            .with_context(|| {
                format!(
                    "Failed to rename remote entry {} to {}",
                    display_path(&source),
                    display_path(&destination)
                )
            })
    }

    pub fn delete_entry(&self, machine_id: &str, path: &str) -> Result<()> {
        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let resolved = resolve_remote_path(&connection.sftp, path)?;
        if resolved == Path::new("/") {
            bail!("Refusing to delete the remote root directory");
        }
        delete_remote_entry(&connection.sftp, &resolved)
    }

    pub fn upload_file(
        &self,
        machine_id: &str,
        local_path: &str,
        remote_parent: &str,
    ) -> Result<u64> {
        let local_path = expand_home_path(local_path);
        if !local_path.is_file() {
            bail!("Upload source must be a local file")
        }
        let name = local_path
            .file_name()
            .and_then(|value| value.to_str())
            .context("Upload source has no valid file name")?;
        validate_entry_name(name)?;

        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let remote_parent = resolve_remote_path(&connection.sftp, remote_parent)?;
        let remote_path = join_remote_path(&remote_parent, name);
        let mut source = fs::File::open(&local_path)
            .with_context(|| format!("Failed to open local file {}", local_path.display()))?;
        let mut destination = connection.sftp.create(&remote_path).with_context(|| {
            format!(
                "Failed to create remote file {}",
                display_path(&remote_path)
            )
        })?;
        let copied = std::io::copy(&mut source, &mut destination)
            .with_context(|| format!("Failed to upload {}", local_path.display()))?;
        destination
            .flush()
            .context("Failed to flush uploaded file")?;
        Ok(copied)
    }

    pub fn download_file(
        &self,
        machine_id: &str,
        remote_path: &str,
        local_path: &str,
    ) -> Result<u64> {
        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let remote_path = resolve_remote_path(&connection.sftp, remote_path)?;
        let stat = connection
            .sftp
            .stat(&remote_path)
            .with_context(|| format!("Failed to inspect {}", display_path(&remote_path)))?;
        if !stat.is_file() {
            bail!("Only remote files can be downloaded")
        }
        let local_path = expand_home_path(local_path);
        let mut source = connection
            .sftp
            .open(&remote_path)
            .with_context(|| format!("Failed to open {}", display_path(&remote_path)))?;
        let mut destination = fs::File::create(&local_path)
            .with_context(|| format!("Failed to create local file {}", local_path.display()))?;
        std::io::copy(&mut source, &mut destination)
            .with_context(|| format!("Failed to download {}", display_path(&remote_path)))
    }

    pub fn set_permissions(&self, machine_id: &str, path: &str, mode: u32) -> Result<()> {
        if mode > 0o7777 {
            bail!("Remote permission mode must be between 0000 and 7777")
        }
        let connection = self.connect(machine_id)?;
        let connection = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock poisoned"))?;
        let resolved = resolve_remote_path(&connection.sftp, path)?;
        let mut stat = connection
            .sftp
            .lstat(&resolved)
            .with_context(|| format!("Failed to inspect {}", display_path(&resolved)))?;
        stat.perm = Some((stat.perm.unwrap_or_default() & !0o7777) | mode);
        connection.sftp.setstat(&resolved, stat).with_context(|| {
            format!(
                "Failed to change permissions for {}",
                display_path(&resolved)
            )
        })
    }

    fn connect(&self, machine_id: &str) -> Result<Arc<Mutex<SftpConnection>>> {
        let machine = self
            .machine_service
            .get(machine_id)
            .with_context(|| format!("SSH machine '{}' not found", machine_id))?;
        let cached = self
            .connections
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(machine_id)
            .cloned();
        if let Some(cached) = cached {
            let reusable = cached
                .lock()
                .map(|connection| {
                    connection.machine_updated_at == machine.updated_at
                        && connection.session.authenticated()
                        && connection.session.keepalive_send().is_ok()
                })
                .unwrap_or(false);
            if reusable {
                return Ok(cached);
            }
            self.disconnect_machine(machine_id);
        }

        let session = self.connection_service.connect_machine(&machine)?;
        let sftp = session.sftp().context("Failed to open SFTP channel")?;
        let connection = Arc::new(Mutex::new(SftpConnection {
            session,
            sftp,
            machine_updated_at: machine.updated_at,
        }));
        self.connections
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(machine_id.to_string(), connection.clone());
        Ok(connection)
    }

    fn disconnect_machine(&self, machine_id: &str) {
        self.connections
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(machine_id);
    }
}

fn resolve_remote_path(sftp: &Sftp, input: &str) -> Result<PathBuf> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed == "~" {
        return sftp
            .realpath(Path::new("."))
            .context("Failed to resolve remote home directory");
    }
    if !trimmed.starts_with('/') && !trimmed.starts_with("~/") {
        bail!("Remote path must be absolute or start with ~")
    }
    let expanded = if let Some(suffix) = trimmed.strip_prefix("~/") {
        join_remote_path(&sftp.realpath(Path::new("."))?, suffix)
    } else {
        PathBuf::from(trimmed)
    };
    sftp.realpath(&expanded)
        .with_context(|| format!("Failed to resolve remote path {}", trimmed))
}

fn join_remote_path(parent: &Path, child: &str) -> PathBuf {
    let parent = display_path(parent);
    let parent = parent.trim_end_matches('/');
    if parent.is_empty() {
        PathBuf::from(format!("/{child}"))
    } else if child.is_empty() {
        PathBuf::from(parent)
    } else {
        PathBuf::from(format!("{parent}/{child}"))
    }
}

fn parent_remote_path(path: &Path) -> Option<PathBuf> {
    let path = display_path(path);
    let path = path.trim_end_matches('/');
    if path.is_empty() || path == "/" {
        return None;
    }
    let separator = path.rfind('/')?;
    Some(PathBuf::from(if separator == 0 {
        "/"
    } else {
        &path[..separator]
    }))
}

fn delete_remote_entry(sftp: &Sftp, path: &Path) -> Result<()> {
    let stat = sftp
        .lstat(path)
        .with_context(|| format!("Failed to inspect remote entry {}", display_path(path)))?;
    if stat.is_dir() && !stat.file_type().is_symlink() {
        for (child, _) in sftp
            .readdir(path)
            .with_context(|| format!("Failed to list remote directory {}", display_path(path)))?
        {
            delete_remote_entry(sftp, &child)?;
        }
        sftp.rmdir(path)
            .with_context(|| format!("Failed to delete remote directory {}", display_path(path)))?;
    } else {
        sftp.unlink(path)
            .with_context(|| format!("Failed to delete remote file {}", display_path(path)))?;
    }
    Ok(())
}

fn validate_entry_name(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        bail!("Remote entry name is invalid")
    }
    if trimmed != name || name.contains('/') || name.contains('\\') || name.contains('\0') {
        bail!("Remote entry name cannot contain path separators or surrounding whitespace")
    }
    Ok(())
}

fn expand_home_path(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(suffix) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(suffix);
        }
    }
    PathBuf::from(path)
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn format_timestamp(timestamp: u64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(timestamp as i64, 0).map(|value| value.to_rfc3339())
}

fn format_permissions(mode: u32) -> String {
    const BITS: [(u32, char); 9] = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    BITS.iter()
        .map(|(bit, marker)| if mode & bit != 0 { *marker } else { '-' })
        .collect()
}

fn language_from_path(path: &str) -> Option<String> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    let language = match extension.as_str() {
        "js" | "jsx" => "javascript",
        "ts" | "tsx" => "typescript",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "json" => "json",
        "md" | "mdx" => "markdown",
        "html" | "htm" => "html",
        "css" => "css",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "sh" | "bash" | "zsh" => "shell",
        _ => return None,
    };
    Some(language.to_string())
}

fn image_mime_type(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_names_reject_path_traversal_and_separators() {
        for invalid in ["", ".", "..", " nested", "nested ", "a/b", "a\\b"] {
            assert!(
                validate_entry_name(invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
        assert!(validate_entry_name("src").is_ok());
        assert!(validate_entry_name(".env").is_ok());
    }

    #[test]
    fn language_detection_handles_common_remote_files() {
        assert_eq!(
            language_from_path("/srv/app/main.rs").as_deref(),
            Some("rust")
        );
        assert_eq!(
            language_from_path("/srv/app/README.md").as_deref(),
            Some("markdown")
        );
        assert_eq!(language_from_path("/srv/app/data.bin"), None);
    }

    #[test]
    fn image_preview_detects_supported_mime_types() {
        assert_eq!(image_mime_type("/srv/logo.PNG"), Some("image/png"));
        assert_eq!(image_mime_type("/srv/photo.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime_type("/srv/vector.svg"), None);
    }

    #[test]
    fn remote_path_helpers_keep_posix_paths_on_windows() {
        assert_eq!(
            display_path(&join_remote_path(Path::new("/root"), "src")),
            "/root/src"
        );
        assert_eq!(
            display_path(&join_remote_path(Path::new("/"), "etc")),
            "/etc"
        );
        assert_eq!(
            parent_remote_path(Path::new("/root/src"))
                .as_deref()
                .map(display_path),
            Some("/root".to_string())
        );
        assert_eq!(
            parent_remote_path(Path::new("/root"))
                .as_deref()
                .map(display_path),
            Some("/".to_string())
        );
    }

    #[test]
    fn formats_remote_permissions_for_file_lists() {
        assert_eq!(format_permissions(0o100755), "rwxr-xr-x");
        assert_eq!(format_permissions(0o100640), "rw-r-----");
    }
}
