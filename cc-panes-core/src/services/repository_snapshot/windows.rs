//! Relative handle opens prevent a concurrently replaced directory/junction from
//! redirecting a snapshot read outside the opened repository root.
use super::files::{missing_or_error, validate_path, SourceFile};
use crate::utils::AppResult;
use std::ffi::c_void;
use std::fs::File;
use std::io::Read;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: *mut c_void,
    object_name: *mut UnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
}

#[repr(C)]
struct IoStatusBlock {
    status: usize,
    information: usize,
}

#[link(name = "ntdll")]
extern "system" {
    fn NtCreateFile(
        handle: *mut *mut c_void,
        access: u32,
        attributes: *mut ObjectAttributes,
        status: *mut IoStatusBlock,
        allocation: *const i64,
        file_attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea: *const c_void,
        ea_length: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

pub(super) fn read(
    root: &File,
    path: &str,
    index_mode: Option<&str>,
) -> AppResult<Option<SourceFile>> {
    validate_path(path)?;
    let mut parent = root.try_clone()?;
    let components: Vec<_> = path.split('/').collect();
    for (index, component) in components.iter().enumerate() {
        let directory = index + 1 < components.len();
        let Some(file) = open_relative(&parent, component, directory)? else {
            return Ok(None);
        };
        if file.metadata()?.file_attributes() & 0x400 != 0 {
            return Err(format!(
                "Snapshot capture does not support Windows reparse points: {path}"
            )
            .into());
        }
        if directory {
            parent = file;
        } else {
            return read_regular(file, path, index_mode).map(Some);
        }
    }
    Err("Missing repository snapshot filename".into())
}

fn open_relative(parent: &File, name: &str, directory: bool) -> AppResult<Option<File>> {
    let mut wide: Vec<u16> = name.encode_utf16().collect();
    let length = u16::try_from(wide.len() * 2).map_err(|_| "Snapshot filename is too long")?;
    let mut name = UnicodeString {
        length,
        maximum_length: length,
        buffer: wide.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle(),
        object_name: &mut name,
        attributes: 0x40, // OBJ_CASE_INSENSITIVE matches ordinary Windows path resolution.
        security_descriptor: std::ptr::null_mut(),
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle = std::ptr::null_mut();
    let options = 0x20 | 0x0020_0000 | if directory { 1 } else { 0x40 };
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            0x0012_0089,
            &mut attributes,
            &mut status,
            std::ptr::null(),
            0,
            7,
            1,
            options,
            std::ptr::null(),
            0,
        )
    };
    if result < 0 {
        return missing_or_error(std::io::Error::from_raw_os_error(unsafe {
            RtlNtStatusToDosError(result)
        } as i32));
    }
    Ok(Some(unsafe { File::from_raw_handle(handle) }))
}

fn read_regular(mut file: File, path: &str, index_mode: Option<&str>) -> AppResult<SourceFile> {
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(format!("Unsupported snapshot file type: {path}").into());
    }
    let mode = match index_mode {
        Some("100755") => "100755",
        Some("120000") => "120000", // Git's core.symlinks=false checkout representation.
        _ => "100644",
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(format!("File changed while capturing repository snapshot: {path}").into());
    }
    Ok(SourceFile { bytes, mode })
}
