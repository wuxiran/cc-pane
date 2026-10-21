use crate::utils::AppResult;
use std::fs;
#[cfg(unix)]
use std::fs::File;
use std::path::{Component, Path};

pub(super) struct SourceFile {
    pub bytes: Vec<u8>,
    pub mode: &'static str,
}

pub(super) fn validate_path(path: &str) -> AppResult<()> {
    if path.is_empty() || path.contains(['\0', '\\', ':']) || path.starts_with('/') {
        return Err("Unsafe repository snapshot path".into());
    }
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git") {
            return Err(format!("Unsafe repository snapshot path: {path}").into());
        }
    }
    if Path::new(path)
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("Unsafe repository snapshot path: {path}").into());
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn read(
    root: &File,
    path: &str,
    _index_mode: Option<&str>,
) -> AppResult<Option<SourceFile>> {
    use std::os::fd::AsRawFd;
    validate_path(path)?;
    let mut parent = root.try_clone()?;
    let components: Vec<_> = path.split('/').collect();
    for component in &components[..components.len() - 1] {
        let Some(next) = open_at(&parent, component, false)? else {
            return Ok(None);
        };
        let metadata = next.metadata()?;
        if metadata.is_file() {
            // A regular file now occupies an old index/baseline directory.
            return Ok(None);
        }
        if !metadata.is_dir() {
            return Err(format!("Unsupported snapshot ancestor type: {path}").into());
        }
        parent = next;
    }
    let name = std::ffi::CString::new(*components.last().ok_or("Missing snapshot filename")?)
        .map_err(|_| "Invalid snapshot filename")?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return missing_or_error(std::io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
        // The old file was replaced by a directory; its children are separate paths.
        return Ok(None);
    }
    if stat.st_mode & libc::S_IFMT == libc::S_IFLNK {
        return read_link(&parent, &name).map(Some);
    }
    let Some(file) = open_at(
        &parent,
        name.to_str().map_err(|_| "Invalid snapshot filename")?,
        false,
    )?
    else {
        return Ok(None);
    };
    read_regular(file, path).map(Some)
}

#[cfg(unix)]
pub(super) fn open_at(parent: &File, name: &str, directory: bool) -> AppResult<Option<File>> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name).map_err(|_| "Invalid snapshot path")?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if descriptor < 0 {
        return missing_or_error(std::io::Error::last_os_error());
    }
    Ok(Some(unsafe { File::from_raw_fd(descriptor) }))
}

#[cfg(unix)]
fn read_link(parent: &File, name: &std::ffi::CStr) -> AppResult<SourceFile> {
    use std::os::fd::AsRawFd;
    let mut bytes = vec![0; 64 * 1024];
    let count = unsafe {
        libc::readlinkat(
            parent.as_raw_fd(),
            name.as_ptr(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
        )
    };
    if count < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if count as usize >= bytes.len() {
        return Err("Snapshot symlink target is too large".into());
    }
    bytes.truncate(count as usize);
    Ok(SourceFile {
        bytes,
        mode: "120000",
    })
}

#[cfg(unix)]
fn read_regular(mut file: File, path: &str) -> AppResult<SourceFile> {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(format!("Unsupported snapshot file type: {path}").into());
    }
    let mode = if before.permissions().mode() & 0o111 == 0 {
        "100644"
    } else {
        "100755"
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(format!("File changed while capturing repository snapshot: {path}").into());
    }
    Ok(SourceFile { bytes, mode })
}

pub(super) fn missing_or_error<T>(error: std::io::Error) -> AppResult<Option<T>> {
    if error.kind() == std::io::ErrorKind::NotFound {
        Ok(None)
    } else {
        Err(error.into())
    }
}

pub(super) struct Scratch {
    pub path: std::path::PathBuf,
}

impl Scratch {
    pub fn new(repository: &Path) -> AppResult<Self> {
        let path = repository.join(format!("capture-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self { path })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.path) {
            tracing::warn!(path = %self.path.display(), %error, "Could not remove snapshot scratch directory");
        }
    }
}

#[cfg(windows)]
pub(super) use super::windows::read;
