//! Save a self-relative owner/group/DACL descriptor for atomic directory creation.
use super::native_error;
use crate::utils::AppResult;
use std::{ffi::c_void, fs::File, os::windows::io::AsRawHandle};

const OWNER_GROUP_DACL: u32 = 7;
const MAX_DESCRIPTOR: u32 = 1024 * 1024;

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

    pub(super) fn same_access(&self, other: &Self) -> AppResult<bool> {
        Ok(self.access()? == other.access()?)
    }

    fn access(&self) -> AppResult<(u16, &[u8], &[u8], &[u8])> {
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
