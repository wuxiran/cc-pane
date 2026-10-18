//! Git omits untracked FIFO/socket/device entries. Check them explicitly while
//! pruning ignored directories (including dependency/build trees).
use super::files;
use crate::utils::AppResult;
use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::fs::File;
use std::os::fd::{AsRawFd, IntoRawFd};

pub(super) fn validate(root: &File, ignored: &HashSet<String>) -> AppResult<()> {
    let mut pending = vec![(root.try_clone()?, String::new())];
    while let Some((directory, prefix)) = pending.pop() {
        for name in names(&directory)? {
            if name == "." || name == ".." || name == ".git" {
                continue;
            }
            let path = format!("{prefix}{name}");
            if ignored.contains(&path) || ignored.contains(&format!("{path}/")) {
                continue;
            }
            files::validate_path(&path)?;
            if inspect(&directory, &name, &path)? {
                if let Some(child) = files::open_at(&directory, &name, true)? {
                    pending.push((child, format!("{path}/")));
                }
            }
        }
    }
    Ok(())
}

fn inspect(directory: &File, name: &str, path: &str) -> AppResult<bool> {
    let name = CString::new(name).map_err(|_| "Invalid snapshot filename")?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        files::missing_or_error::<()>(std::io::Error::last_os_error())?;
        return Ok(false);
    }
    let kind = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
    match kind {
        libc::S_IFDIR => Ok(true),
        libc::S_IFREG | libc::S_IFLNK => Ok(false),
        _ => Err(format!("Unsupported snapshot file type: {path}").into()),
    }
}

struct Directory(*mut libc::DIR);

impl Drop for Directory {
    fn drop(&mut self) {
        unsafe { libc::closedir(self.0) };
    }
}

fn names(directory: &File) -> AppResult<Vec<String>> {
    let descriptor = directory.try_clone()?.into_raw_fd();
    let pointer = unsafe { libc::fdopendir(descriptor) };
    if pointer.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe { libc::close(descriptor) };
        return Err(error.into());
    }
    let directory = Directory(pointer);
    let mut names = Vec::new();
    loop {
        errno::set_errno(errno::Errno(0));
        let entry = unsafe { libc::readdir(directory.0) };
        if entry.is_null() {
            let error = errno::errno().0;
            if error != 0 {
                return Err(std::io::Error::from_raw_os_error(error).into());
            }
            return Ok(names);
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        names.push(
            name.to_str()
                .map_err(|_| "Repository snapshots require UTF-8 filenames")?
                .to_string(),
        );
    }
}
