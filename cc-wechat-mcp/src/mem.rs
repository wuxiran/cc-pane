//! Windows 进程内存读取（替代 Linux /proc/<pid>/mem）。需管理员权限读 Weixin.exe 内存。
//! 非 Windows 平台只提供返回「不可用」的桩，真正逻辑在 session 层提前被 NOT_WINDOWS 拦住。

#[cfg(windows)]
pub use win::*;

#[cfg(not(windows))]
pub fn find_weixin_pid() -> Option<u32> {
    None
}

#[cfg(windows)]
mod win {
    use anyhow::{anyhow, Result};
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Memory::{
        VirtualQueryEx, MEMORY_BASIC_INFORMATION, MEM_COMMIT, MEM_PRIVATE, PAGE_EXECUTE_READWRITE,
        PAGE_EXECUTE_WRITECOPY, PAGE_READWRITE, PAGE_WRITECOPY,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    const MAX_REGION_SIZE: u64 = 512 * 1024 * 1024; // 跳过超大区域
    const WRITABLE: u32 =
        PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;

    /// 句柄的瘦封装，Drop 时自动 CloseHandle。
    pub struct ProcHandle(HANDLE);

    impl Drop for ProcHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    impl ProcHandle {
        pub fn raw(&self) -> HANDLE {
            self.0
        }
    }

    /// 查找微信 4.0 主进程 Weixin.exe（排除小程序运行时）。多个时选私有内存最大者。
    pub fn find_weixin_pid() -> Option<u32> {
        let mut candidates: Vec<(usize, u32)> = Vec::new(); // (private_bytes, pid)
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                let name = wide_to_string(&entry.szExeFile).to_lowercase();
                if name == "weixin.exe" {
                    let pid = entry.th32ProcessID;
                    let mem = private_usage(pid).unwrap_or(0);
                    candidates.push((mem, pid));
                }
                ok = Process32NextW(snap, &mut entry);
            }
            CloseHandle(snap);
        }
        candidates.sort_by_key(|c| std::cmp::Reverse(c.0));
        let pid = candidates.first().map(|c| c.1);
        if let Some(p) = pid {
            log::info!(
                "找到 Weixin.exe 主进程 PID={}（共 {} 个候选）",
                p,
                candidates.len()
            );
        }
        pid
    }

    fn private_usage(pid: u32) -> Option<usize> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            if h.is_null() {
                return None;
            }
            let guard = ProcHandle(h);
            let mut counters: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            let ok = GetProcessMemoryInfo(
                guard.raw(),
                &mut counters as *mut _ as *mut _,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            );
            if ok != 0 {
                Some(counters.PrivateUsage)
            } else {
                None
            }
        }
    }

    fn wide_to_string(w: &[u16]) -> String {
        let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
        String::from_utf16_lossy(&w[..end])
    }

    /// 打开进程句柄用于读内存。失败通常是权限不足。
    pub fn open_process(pid: u32) -> Result<ProcHandle> {
        unsafe {
            let h = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid);
            if h.is_null() {
                let err = std::io::Error::last_os_error();
                return Err(anyhow!(
                    "OpenProcess 失败 (pid={pid}, {err})。请以管理员权限运行。"
                ));
            }
            Ok(ProcHandle(h))
        }
    }

    /// 枚举可读写、已提交的私有内存区域（密钥藏在私有堆里）。
    pub fn enum_regions(handle: &ProcHandle) -> Vec<(u64, usize)> {
        let mut regions = Vec::new();
        let mut address: u64 = 0;
        let max_addr: u64 = 0x7FFF_FFFF_FFFF; // 用户态上限
        unsafe {
            let mut mbi: MEMORY_BASIC_INFORMATION = std::mem::zeroed();
            while address < max_addr {
                let ret = VirtualQueryEx(
                    handle.raw(),
                    address as *const c_void,
                    &mut mbi,
                    std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
                );
                if ret == 0 {
                    break;
                }
                let base = mbi.BaseAddress as u64;
                let size = mbi.RegionSize as u64;
                if size == 0 {
                    break;
                }
                if mbi.State == MEM_COMMIT
                    && mbi.Type == MEM_PRIVATE
                    && (mbi.Protect & WRITABLE) != 0
                    && size <= MAX_REGION_SIZE
                {
                    regions.push((base, size as usize));
                }
                address = base + size;
            }
        }
        log::info!("枚举到 {} 个可读写私有内存区域", regions.len());
        regions
    }

    /// 读取指定内存区域，失败返回 None。
    pub fn read_region(handle: &ProcHandle, base: u64, size: usize) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; size];
        let mut read: usize = 0;
        unsafe {
            let ok = ReadProcessMemory(
                handle.raw(),
                base as *const c_void,
                buf.as_mut_ptr() as *mut c_void,
                size,
                &mut read,
            );
            if ok == 0 || read == 0 {
                return None;
            }
        }
        buf.truncate(read);
        Some(buf)
    }
}
