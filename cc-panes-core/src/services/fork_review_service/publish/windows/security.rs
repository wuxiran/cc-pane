//! Save a self-relative owner/group/DACL descriptor for atomic directory creation.
use super::native_error;
use crate::utils::AppResult;
use std::{ffi::c_void, fs::File, os::windows::io::AsRawHandle};

const OWNER_GROUP_DACL: u32 = 7;
const MAX_DESCRIPTOR: u32 = 1024 * 1024;
const DACL_PRESENT: u16 = 0x0004;
const DACL_AUTO_INHERITED: u16 = 0x0400;
const DACL_PROTECTED: u16 = 0x1000;
const PROTECTED_AUTO_INHERITED_DACL: u16 = DACL_PRESENT | DACL_AUTO_INHERITED | DACL_PROTECTED;
const WRITE_DAC: u32 = 0x0004_0000;

type AccessComponents<'a> = (u16, &'a [u8], &'a [u8], &'a [u8]);

#[link(name = "ntdll")]
extern "system" {
    fn NtQuerySecurityObject(
        handle: *mut c_void,
        information: u32,
        descriptor: *mut c_void,
        length: u32,
        needed: *mut u32,
    ) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn SetSecurityInfo(
        handle: *mut c_void,
        kind: u32,
        information: u32,
        owner: *const c_void,
        group: *const c_void,
        dacl: *const c_void,
        sacl: *const c_void,
    ) -> u32;
}

#[derive(Clone)]
pub(super) struct Descriptor {
    storage: Vec<usize>,
    length: usize,
}

impl Descriptor {
    pub(super) fn read(file: &File) -> AppResult<Self> {
        let mut needed = 0;
        let status = unsafe {
            NtQuerySecurityObject(
                file.as_raw_handle(),
                OWNER_GROUP_DACL,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        if !(20..=MAX_DESCRIPTOR).contains(&needed) {
            return Err(native_error(status).into());
        }
        let mut storage = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        let capacity = needed;
        let status = unsafe {
            NtQuerySecurityObject(
                file.as_raw_handle(),
                OWNER_GROUP_DACL,
                storage.as_mut_ptr().cast(),
                capacity,
                &mut needed,
            )
        };
        if status < 0 {
            return Err(native_error(status).into());
        }
        if needed > capacity {
            return Err("Security descriptor changed while reading".into());
        }
        let descriptor = Self {
            storage,
            length: needed as usize,
        };
        descriptor.access()?;
        Ok(descriptor)
    }

    pub(super) fn as_ptr(&self) -> *mut c_void {
        self.storage.as_ptr().cast_mut().cast()
    }

    pub(super) fn creation_access(&self) -> AppResult<u32> {
        let (control, _, _, dacl) = self.access()?;
        // NtCreateFile can clear AUTO_INHERITED on an explicitly protected DACL.
        // Only that source policy needs permission to reapply the same DACL.
        let needs_reapplication = control & PROTECTED_AUTO_INHERITED_DACL
            == PROTECTED_AUTO_INHERITED_DACL
            && !dacl.is_empty();
        Ok(if needs_reapplication { WRITE_DAC } else { 0 })
    }

    pub(super) fn restore_created_inheritance(&self, directory: &File) -> AppResult<()> {
        if self.creation_access()? == 0 {
            return Ok(());
        }
        let expected = self.access()?;
        let created = Self::read(directory)?;
        let actual = created.access()?;
        if actual.0 != (expected.0 & !DACL_AUTO_INHERITED)
            || actual.1 != expected.1
            || actual.2 != expected.2
            || actual.3 != expected.3
        {
            return Ok(());
        }
        // The newly created directory is empty. Reapply its identical protected
        // DACL so Windows establishes the saved automatic inheritance state.
        // Keep the caller's complete descriptor comparison after this operation.
        let status = unsafe {
            SetSecurityInfo(
                directory.as_raw_handle(),
                1,           // SE_FILE_OBJECT
                0x8000_0004, // PROTECTED_DACL_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION
                std::ptr::null(),
                std::ptr::null(),
                expected.3.as_ptr().cast(),
                std::ptr::null(),
            )
        };
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status as i32).into());
        }
        Ok(())
    }

    pub(super) fn same_access(&self, other: &Self) -> AppResult<bool> {
        Ok(self.access()? == other.access()?)
    }

    fn access(&self) -> AppResult<AccessComponents<'_>> {
        let bytes =
            unsafe { std::slice::from_raw_parts(self.storage.as_ptr().cast::<u8>(), self.length) };
        if bytes.len() < 20 {
            return Err("Incomplete directory security descriptor".into());
        }
        let control = u16::from_le_bytes([bytes[2], bytes[3]]);
        if control & 0x8000 == 0 {
            return Err("Directory security descriptor is not self-relative".into());
        }
        let part = |index, acl| component(bytes, index, acl);
        Ok((control, part(4, false)?, part(8, false)?, part(16, true)?))
    }
}

fn component(bytes: &[u8], index: usize, acl: bool) -> AppResult<&[u8]> {
    let offset = u32::from_le_bytes(bytes[index..index + 4].try_into().unwrap()) as usize;
    if offset == 0 {
        return Ok(&[]);
    }
    let data = bytes
        .get(offset..)
        .filter(|data| data.len() >= 8)
        .ok_or("Invalid security descriptor offset")?;
    let length = if acl {
        u16::from_le_bytes([data[2], data[3]]) as usize
    } else {
        8 + 4 * data[1] as usize
    };
    if length < 8 {
        return Err("Invalid security descriptor component size".into());
    }
    data.get(..length)
        .ok_or_else(|| "Invalid security descriptor component".into())
}
