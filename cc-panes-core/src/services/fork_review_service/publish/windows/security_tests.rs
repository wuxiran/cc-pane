use super::*;
use std::cell::Cell;
use std::fs;

#[link(name = "advapi32")]
extern "system" {
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        size: *mut u32,
    ) -> i32;
    fn GetSecurityDescriptorDacl(
        descriptor: *const c_void,
        present: *mut i32,
        acl: *mut *mut c_void,
        defaulted: *mut i32,
    ) -> i32;
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
#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
}

struct AllocatedDescriptor(*mut c_void);
impl Drop for AllocatedDescriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn directory(path: &Path, access: u32) -> File {
    OpenOptions::new()
        .access_mode(access)
        .custom_flags(0x0200_0000 | 0x0020_0000)
        .open(path)
        .unwrap()
}

fn protected_dacl(path: &Path, text: &str) {
    let wide: Vec<_> = text.encode_utf16().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        },
        0,
        "invalid fixture SDDL {text}: {}",
        std::io::Error::last_os_error()
    );
    let descriptor = AllocatedDescriptor(descriptor);
    let (mut present, mut defaulted, mut acl) = (0, 0, std::ptr::null_mut());
    assert_ne!(
        unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted) },
        0
    );
    assert_ne!(present, 0);
    let handle = directory(path, READ | 0x0004_0000);
    assert_eq!(
        unsafe {
            SetSecurityInfo(
                handle.as_raw_handle(),
                1,
                0x8000_0004,
                std::ptr::null(),
                std::ptr::null(),
                acl,
                std::ptr::null(),
            )
        },
        0
    );
}

fn changes(root: &Path) -> Vec<super::super::Change> {
    fs::create_dir(root.join("module")).unwrap();
    fs::write(root.join("module/item"), "before").unwrap();
    let file = |text: &str| {
        Some(SnapshotFile {
            bytes: text.as_bytes().to_vec(),
            mode: "100644".into(),
        })
    };
    vec![
        ("module".into(), None, file("after")),
        ("module/item".into(), file("before"), None),
    ]
}

#[test]
fn rollback_preserves_directory_owner_group_and_protected_custom_dacl() {
    let temp = tempfile::tempdir().unwrap();
    let changes = changes(temp.path());
    let path = temp.path().join("module");
    // Keep existing children accessible when SetSecurityInfo propagates the DACL.
    protected_dacl(&path, "D:P(A;OICI;FA;;;OW)");
    assert_eq!(fs::read(path.join("item")).unwrap(), b"before");
    let before = security::Descriptor::read(&directory(&path, READ)).unwrap();
    let injected = Cell::new(false);
    let error = super::super::publish_with(temp.path(), &changes, |index| {
        if index == 0 {
            injected.set(true);
            Err("injected failure".into())
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert!(
        injected.get(),
        "publication failed before injection: {error}"
    );
    assert!(error.to_string().contains("injected failure"), "{error}");
    assert!(error.to_string().contains("rolled back"), "{error}");
    let after = security::Descriptor::read(&directory(&path, READ)).unwrap();
    assert!(before.same_access(&after).unwrap());
    assert_eq!(fs::read(path.join("item")).unwrap(), b"before");
    assert!(fs::read_dir(temp.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".cc-panes-security-probe-")));
}

#[test]
fn inability_to_recreate_directory_security_is_rejected_before_file_changes() {
    let temp = tempfile::tempdir().unwrap();
    let changes = changes(temp.path());
    // FILE_ADD_SUBDIRECTORY (0x4) has no SDDL abbreviation; deny it only here.
    protected_dacl(temp.path(), "D:P(D;;0x4;;;WD)(A;OICI;FA;;;OW)");
    assert_eq!(
        fs::read(temp.path().join("module/item")).unwrap(),
        b"before"
    );
    let wrote_file = Cell::new(false);
    let result = super::super::publish_with(temp.path(), &changes, |_| {
        wrote_file.set(true);
        Ok(())
    });
    assert!(result.is_err());
    assert!(
        !wrote_file.get(),
        "publication changed files before rejecting the DACL"
    );
    assert_eq!(
        fs::read(temp.path().join("module/item")).unwrap(),
        b"before"
    );
}
