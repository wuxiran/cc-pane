use super::{ensure_matches, SnapshotFile};
use crate::utils::AppResult;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub(super) struct SafeRoot {
    directory: File,
    original_permissions: RefCell<HashMap<String, u32>>,
}

impl SafeRoot {
    pub fn new(path: &Path) -> AppResult<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)?;
        Ok(Self {
            directory: file,
            original_permissions: RefCell::new(HashMap::new()),
        })
    }

    pub fn read(&self, path: &str, _mode_hint: Option<&str>) -> AppResult<Option<SnapshotFile>> {
        let Some((parent, name)) = self.parent(path, false, &mut vec![])? else {
            return Ok(None);
        };
        let Some(mut file) = open_at(&parent, &name, libc::O_RDONLY | libc::O_NONBLOCK)? else {
            return Ok(None);
        };
        let before = file.metadata()?;
        if !before.is_file() {
            return Err(format!("Publication target is not a regular file: {path}").into());
        }
        self.original_permissions
            .borrow_mut()
            .entry(path.to_string())
            .or_insert(before.permissions().mode() & 0o777);
        let mode = if before.permissions().mode() & 0o111 == 0 {
            "100644"
        } else {
            "100755"
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if before.len() != after.len()
            || before.modified()? != after.modified()?
            || before.permissions() != after.permissions()
        {
            return Err(format!("File changed while checking publication: {path}").into());
        }
        Ok(Some(SnapshotFile {
            bytes,
            mode: mode.to_string(),
        }))
    }

    pub fn apply(
        &self,
        path: &str,
        before: &Option<SnapshotFile>,
        after: &Option<SnapshotFile>,
        directories: &mut Vec<String>,
    ) -> AppResult<()> {
        ensure_matches(self, path, before)?;
        let Some((parent, name)) = self.parent(path, after.is_some(), directories)? else {
            return if after.is_none() {
                Ok(())
            } else {
                Err("Publication parent directory disappeared".into())
            };
        };
        if let Some(after) = after {
            let permissions = self.target_permissions(&parent, &name, path, after)?;
            let temporary = Temporary::write(&parent, after, permissions)?;
            ensure_matches(self, path, before)?;
            let result = unsafe {
                libc::renameat(
                    parent.as_raw_fd(),
                    temporary.name.as_ptr(),
                    parent.as_raw_fd(),
                    name.as_ptr(),
                )
            };
            if result != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            temporary.disarm();
        } else {
            ensure_matches(self, path, before)?;
            if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        Ok(())
    }

    fn parent(
        &self,
        path: &str,
        create: bool,
        directories: &mut Vec<String>,
    ) -> AppResult<Option<(File, CString)>> {
        let mut parent = self.directory.try_clone()?;
        let mut prefix = String::new();
        let parts: Vec<_> = path.split('/').collect();
        for part in &parts[..parts.len() - 1] {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let name = CString::new(*part).map_err(|_| "Invalid publication path")?;
            let next = open_at(&parent, &name, libc::O_RDONLY | libc::O_DIRECTORY)?;
            parent = match next {
                Some(next) => next,
                None if create => create_directory(&parent, &name, &prefix, directories)?,
                None => return Ok(None),
            };
        }
        let name = CString::new(*parts.last().ok_or("Missing publication filename")?)
            .map_err(|_| "Invalid publication filename")?;
        Ok(Some((parent, name)))
    }

    pub fn remove_empty_directory(&self, path: &str) -> AppResult<()> {
        let Some((parent, name)) = self.parent(path, false, &mut vec![])? else {
            return Ok(());
        };
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.into());
            }
        }
        Ok(())
    }

    fn target_permissions(
        &self,
        parent: &File,
        name: &CString,
        path: &str,
        after: &SnapshotFile,
    ) -> AppResult<Option<u32>> {
        let current = open_at(parent, name, libc::O_RDONLY | libc::O_NONBLOCK)?;
        let mode = match current {
            Some(file) => Some(file.metadata()?.permissions().mode() & 0o777),
            None => self.original_permissions.borrow().get(path).copied(),
        };
        Ok(mode.map(|mode| {
            if after.mode == "100755" {
                mode | 0o100
            } else {
                mode & !0o111
            }
        }))
    }
}

fn create_directory(
    parent: &File,
    name: &CString,
    prefix: &str,
    directories: &mut Vec<String>,
) -> AppResult<File> {
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o755) } == 0 {
        directories.push(prefix.to_string());
    } else if std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
        return Err(std::io::Error::last_os_error().into());
    }
    open_at(parent, name, libc::O_RDONLY | libc::O_DIRECTORY)?
        .ok_or_else(|| "Publication directory disappeared".into())
}

fn open_at(parent: &File, name: &CString, flags: i32) -> AppResult<Option<File>> {
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        return if error.kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error.into())
        };
    }
    Ok(Some(unsafe { File::from_raw_fd(descriptor) }))
}

struct Temporary<'a> {
    parent: &'a File,
    name: CString,
    armed: bool,
}

impl<'a> Temporary<'a> {
    fn write(
        parent: &'a File,
        contents: &SnapshotFile,
        permissions: Option<u32>,
    ) -> AppResult<Self> {
        let name = CString::new(format!(".cc-panes-publish-{}", uuid::Uuid::new_v4()))
            .map_err(|_| "Invalid temporary filename")?;
        let descriptor = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o700,
            )
        };
        if descriptor < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let temporary = Self {
            parent,
            name,
            armed: true,
        };
        let mut file = unsafe { File::from_raw_fd(descriptor) };
        file.write_all(&contents.bytes)?;
        let new_mode = file.metadata()?.permissions().mode()
            & if contents.mode == "100755" {
                0o700
            } else {
                0o600
            };
        let permissions = permissions.unwrap_or(new_mode);
        if contents.mode == "100755" && permissions & 0o111 == 0 {
            return Err(
                "The process umask prevents creation of an executable publication file".into(),
            );
        }
        file.set_permissions(std::fs::Permissions::from_mode(permissions))?;
        file.sync_all()?;
        Ok(temporary)
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        if self.armed
            && unsafe { libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), 0) } != 0
        {
            tracing::warn!(error = %std::io::Error::last_os_error(), "Could not clean publication temporary file");
        }
    }
}
