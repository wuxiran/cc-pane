use super::{ensure_matches, SnapshotFile};
use crate::utils::AppResult;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;

mod security;
#[cfg(test)]
mod security_tests;

const READ: u32 = 0x0012_0089;
const WRITE_DELETE: u32 = 0x0013_0116;
const DELETE: u32 = 0x0001_0000;

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}
#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root: *mut c_void,
    name: *mut UnicodeString,
    attributes: u32,
    security: *mut c_void,
    security_quality: *mut c_void,
}
#[repr(C)]
struct IoStatus {
    status: usize,
    information: usize,
}

#[link(name = "ntdll")]
extern "system" {
    fn NtCreateFile(
        handle: *mut *mut c_void,
        access: u32,
        attributes: *mut ObjectAttributes,
        status: *mut IoStatus,
        allocation: *const i64,
        file_attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea: *const c_void,
        ea_length: u32,
    ) -> i32;
    fn NtSetInformationFile(
        handle: *mut c_void,
        status: *mut IoStatus,
        information: *const c_void,
        length: u32,
        class: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

#[derive(Clone)]
pub(super) struct DirectoryState {
    permissions: std::fs::Permissions,
    security: security::Descriptor,
}

impl DirectoryState {
    fn read(file: &File) -> AppResult<Self> {
        Ok(Self {
            permissions: file.metadata()?.permissions(),
            security: security::Descriptor::read(file)?,
        })
    }
}

pub(super) struct SafeRoot {
    directory: File,
    directory_states: RefCell<HashMap<String, DirectoryState>>,
}

impl SafeRoot {
    pub fn new(path: &Path) -> AppResult<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(path)?;
        reject_reparse(&file)?;
        Ok(Self {
            directory: file,
            directory_states: RefCell::new(HashMap::new()),
        })
    }

    pub fn read(&self, path: &str, mode_hint: Option<&str>) -> AppResult<Option<SnapshotFile>> {
        let Some((parent, name)) = self.parent(path, false, &mut vec![])? else {
            return Ok(None);
        };
        let Some((mut file, _)) = open_relative(&parent, &name, None, READ, 1)? else {
            return Ok(None);
        };
        reject_reparse(&file)?;
        let before = file.metadata()?;
        if before.is_dir() {
            return Ok(None);
        }
        if !before.is_file() {
            return Err(format!("Publication target is not a regular file: {path}").into());
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if before.len() != after.len() || before.modified()? != after.modified()? {
            return Err(format!("File changed while checking publication: {path}").into());
        }
        Ok(Some(SnapshotFile {
            bytes,
            mode: mode_hint.unwrap_or("100644").to_string(),
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
                Err("Publication parent disappeared".into())
            };
        };
        if let Some(after) = after {
            let mut temporary = Temporary::write(&parent, after)?;
            ensure_matches(self, path, before)?;
            rename(&temporary.file, &parent, &name)?;
            temporary.armed = false;
        } else {
            let (file, _) = open_relative(&parent, &name, Some(false), READ | DELETE, 1)?
                .ok_or("Publication target disappeared")?;
            reject_reparse(&file)?;
            ensure_matches(self, path, before)?;
            delete(&file)?;
        }
        Ok(())
    }

    fn parent(
        &self,
        path: &str,
        create: bool,
        directories: &mut Vec<String>,
    ) -> AppResult<Option<(File, String)>> {
        let mut parent = self.directory.try_clone()?;
        let mut prefix = String::new();
        let parts: Vec<_> = path.split('/').collect();
        for part in &parts[..parts.len() - 1] {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let Some((next, created)) = open_relative(
                &parent,
                part,
                create.then_some(true),
                READ,
                if create { 3 } else { 1 },
            )?
            else {
                return Ok(None);
            };
            reject_reparse(&next)?;
            let metadata = next.metadata()?;
            if metadata.is_file() && !create {
                return Ok(None);
            }
            if !metadata.is_dir() {
                return Err(format!("Publication parent is not a directory: {prefix}").into());
            }
            if created {
                directories.push(prefix.clone());
            }
            parent = next;
        }
        Ok(Some((
            parent,
            parts
                .last()
                .ok_or("Missing publication filename")?
                .to_string(),
        )))
    }

    pub fn preflight_directory_restore(&self, path: &str) -> AppResult<()> {
        if self.directory_states.borrow().contains_key(path) {
            return Ok(());
        }
        let Some((parent, name)) = self.parent(path, false, &mut vec![])? else {
            return Ok(());
        };
        let Some((directory, _)) = open_relative(&parent, &name, Some(true), READ, 1)? else {
            return Ok(());
        };
        reject_reparse(&directory)?;
        let state = DirectoryState::read(&directory)?;
        let probe_name = format!(".cc-panes-security-probe-{}", uuid::Uuid::new_v4());
        let (probe, original) = create_secured_directory(&parent, &probe_name, &state)?;
        let cleanup = probe
            .set_permissions(original)
            .map_err(crate::utils::AppError::from)
            .and_then(|_| delete(&probe));
        if let Err(error) = cleanup {
            return Err(format!(
                "Could not clean directory security probe {path}/../{probe_name}: {error}"
            )
            .into());
        }
        self.directory_states
            .borrow_mut()
            .insert(path.to_string(), state);
        Ok(())
    }

    pub fn remove_empty_directory(
        &self,
        path: &str,
        restore_required: bool,
    ) -> AppResult<Option<DirectoryState>> {
        let Some((parent, name)) = self.parent(path, false, &mut vec![])? else {
            return Ok(None);
        };
        if let Some((directory, _)) = open_relative(&parent, &name, Some(true), READ | DELETE, 1)? {
            reject_reparse(&directory)?;
            let state = DirectoryState::read(&directory)?;
            let saved = self.directory_states.borrow();
            if let Some(expected) = saved.get(path) {
                if state.permissions != expected.permissions
                    || !state.security.same_access(&expected.security)?
                {
                    return Err(
                        format!("Directory permissions changed since preflight: {path}").into(),
                    );
                }
            } else if restore_required {
                return Err(
                    format!("Directory appeared after permission preflight: {path}").into(),
                );
            }
            delete(&directory)?;
            return Ok(Some(state));
        }
        Ok(None)
    }

    pub fn restore_directory(&self, path: &str, state: &DirectoryState) -> AppResult<()> {
        let (parent, name) = self
            .parent(path, false, &mut vec![])?
            .ok_or("Rollback directory parent disappeared")?;
        create_secured_directory(&parent, &name, state)?;
        Ok(())
    }
}

fn open_relative(
    parent: &File,
    name: &str,
    directory: Option<bool>,
    access: u32,
    disposition: u32,
) -> AppResult<Option<(File, bool)>> {
    open_relative_secured(parent, name, directory, access, disposition, None)
}

fn open_relative_secured(
    parent: &File,
    name: &str,
    directory: Option<bool>,
    access: u32,
    disposition: u32,
    security: Option<&security::Descriptor>,
) -> AppResult<Option<(File, bool)>> {
    let mut wide: Vec<u16> = name.encode_utf16().collect();
    let length = u16::try_from(wide.len() * 2).map_err(|_| "Publication filename is too long")?;
    let mut name = UnicodeString {
        length,
        maximum_length: length,
        buffer: wide.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root: parent.as_raw_handle(),
        name: &mut name,
        attributes: 0x40, // OBJ_CASE_INSENSITIVE matches ordinary Windows path resolution.
        security: security.map_or(std::ptr::null_mut(), security::Descriptor::as_ptr),
        security_quality: std::ptr::null_mut(),
    };
    native_open(&mut attributes, directory, access, disposition)
}

fn create_secured_directory(
    parent: &File,
    name: &str,
    state: &DirectoryState,
) -> AppResult<(File, std::fs::Permissions)> {
    let (directory, _) = open_relative_secured(
        parent,
        name,
        Some(true),
        READ | DELETE | 0x100 | state.security.creation_access()?,
        2,
        Some(&state.security),
    )?
    .ok_or("Could not create secured rollback directory")?;
    let original = directory.metadata()?.permissions();
    let result = (|| {
        reject_reparse(&directory)?;
        state.security.restore_created_inheritance(&directory)?;
        if !security::Descriptor::read(&directory)?.same_access(&state.security)? {
            return Err("Windows could not preserve the directory owner, group and ACL".into());
        }
        directory.set_permissions(state.permissions.clone())?;
        Ok(())
    })();
    if let Err(error) = result {
        let cleanup = directory
            .set_permissions(original.clone())
            .map_err(crate::utils::AppError::from)
            .and_then(|_| delete(&directory));
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup) => {
                format!("{error}; could not remove incomplete secured directory {name}: {cleanup}")
                    .into()
            }
        });
    }
    Ok((directory, original))
}

fn native_open(
    attributes: &mut ObjectAttributes,
    directory: Option<bool>,
    access: u32,
    disposition: u32,
) -> AppResult<Option<(File, bool)>> {
    let mut status = IoStatus {
        status: 0,
        information: 0,
    };
    let mut handle = std::ptr::null_mut();
    let options = 0x20
        | 0x0020_0000
        | match directory {
            Some(true) => 1,
            Some(false) => 0x40,
            None => 0,
        };
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            attributes,
            &mut status,
            std::ptr::null(),
            0,
            7,
            disposition,
            options,
            std::ptr::null(),
            0,
        )
    };
    if result < 0 {
        let error = native_error(result);
        return if error.kind() == std::io::ErrorKind::NotFound && disposition == 1 {
            Ok(None)
        } else {
            Err(error.into())
        };
    }
    Ok(Some((
        unsafe { File::from_raw_handle(handle) },
        status.information == 2,
    )))
}

fn reject_reparse(file: &File) -> AppResult<()> {
    if file.metadata()?.file_attributes() & 0x400 != 0 {
        return Err("Publication refuses symlinks and Windows reparse points".into());
    }
    Ok(())
}

fn native_error(status: i32) -> std::io::Error {
    std::io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
}

fn set_information(file: &File, bytes: &[u8], class: u32) -> AppResult<()> {
    let mut status = IoStatus {
        status: 0,
        information: 0,
    };
    let result = unsafe {
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut status,
            bytes.as_ptr().cast(),
            bytes.len() as u32,
            class,
        )
    };
    if result < 0 {
        return Err(native_error(result).into());
    }
    Ok(())
}

fn rename(file: &File, parent: &File, name: &str) -> AppResult<()> {
    let wide: Vec<u16> = name.encode_utf16().collect();
    let pointer_size = std::mem::size_of::<usize>();
    let offset = pointer_size * 2 + 4;
    let length = offset + wide.len() * 2;
    let mut storage = vec![0usize; length.div_ceil(pointer_size)];
    let bytes =
        unsafe { std::slice::from_raw_parts_mut(storage.as_mut_ptr().cast::<u8>(), length) };
    bytes[..4].copy_from_slice(&3u32.to_ne_bytes()); // replace + POSIX atomic rename semantics
    bytes[pointer_size..pointer_size * 2]
        .copy_from_slice(&(parent.as_raw_handle() as usize).to_ne_bytes());
    bytes[pointer_size * 2..offset].copy_from_slice(&((wide.len() * 2) as u32).to_ne_bytes());
    for (chunk, character) in bytes[offset..].as_chunks_mut::<2>().0.iter_mut().zip(wide) {
        *chunk = character.to_ne_bytes();
    }
    set_information(file, bytes, 65) // FileRenameInformationEx; no delete-then-rename fallback.
}

fn delete(file: &File) -> AppResult<()> {
    set_information(file, &3u32.to_ne_bytes(), 64) // FileDispositionInformationEx: delete + POSIX.
}

struct Temporary {
    file: File,
    armed: bool,
}

impl Temporary {
    fn write(parent: &File, contents: &SnapshotFile) -> AppResult<Self> {
        let name = format!(".cc-panes-publish-{}", uuid::Uuid::new_v4());
        let (file, _) = open_relative(parent, &name, Some(false), WRITE_DELETE, 2)?
            .ok_or("Cannot create publication temporary file")?;
        let mut temporary = Self { file, armed: true };
        temporary.file.write_all(&contents.bytes)?;
        temporary.file.sync_all()?;
        Ok(temporary)
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        if self.armed {
            if let Err(error) = delete(&self.file) {
                tracing::warn!(%error, "Could not clean publication temporary file");
            }
        }
    }
}
