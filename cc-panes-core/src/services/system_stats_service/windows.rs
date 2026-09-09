use super::{cpu_percent_since, ProcessSnapshot, ResourceProcessSampler, WindowsCpuSample};
use std::collections::{HashMap, HashSet};

pub(super) fn refresh_process_details(
    processes: &mut [ProcessSnapshot],
    relevant: &HashSet<u32>,
    sampler: &mut ResourceProcessSampler,
) {
    let sampled_at = std::time::Instant::now();
    let mut next_samples = HashMap::with_capacity(relevant.len());
    for process in processes
        .iter_mut()
        .filter(|process| relevant.contains(&process.pid))
    {
        let Some(details) = query_process_details(process.pid) else {
            continue;
        };
        process.command = details.command;
        process.started_at = details
            .cpu_times
            .map(|(creation_time_100ns, _)| creation_time_100ns);
        process.memory_bytes = details.memory_bytes;
        if let Some((creation_time_100ns, total_time_100ns)) = details.cpu_times {
            process.cpu_percent = sampler
                .cpu_samples
                .get(&process.pid)
                .filter(|previous| previous.creation_time_100ns == creation_time_100ns)
                .map(|previous| {
                    cpu_percent_since(
                        previous.total_time_100ns,
                        total_time_100ns,
                        sampled_at.saturating_duration_since(previous.sampled_at),
                    )
                })
                .unwrap_or(0.0);
            next_samples.insert(
                process.pid,
                WindowsCpuSample {
                    creation_time_100ns,
                    total_time_100ns,
                    sampled_at,
                },
            );
        }
    }
    sampler.cpu_samples = next_samples;
}

pub(super) struct ProcessDetails {
    pub(super) command: String,
    pub(super) memory_bytes: u64,
    pub(super) private_bytes: Option<u64>,
    pub(super) cpu_times: Option<(u64, u64)>,
}

pub(super) fn query_process_details(pid: u32) -> Option<ProcessDetails> {
    use ::windows::Win32::Foundation::{CloseHandle, FILETIME};
    use ::windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
    };
    use ::windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_VM_READ,
    };

    // A single handle serves command line, memory, and CPU counters for this selected PID.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
            .or_else(|_| OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid))
            .ok()?;

        let command = query_command_line(handle).unwrap_or_default();
        let mut counters = PROCESS_MEMORY_COUNTERS_EX {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            ..Default::default()
        };
        let memory_ok = GetProcessMemoryInfo(
            handle,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
            counters.cb,
        )
        .is_ok();
        let memory_bytes = if memory_ok {
            counters.WorkingSetSize as u64
        } else {
            0
        };
        let private_bytes = memory_ok.then_some(counters.PrivateUsage as u64);

        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let cpu_times = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
            .ok()
            .map(|_| {
                (
                    filetime_100ns(creation),
                    filetime_100ns(kernel).saturating_add(filetime_100ns(user)),
                )
            });

        let _ = CloseHandle(handle);
        Some(ProcessDetails {
            command,
            memory_bytes,
            private_bytes,
            cpu_times,
        })
    }
}

fn filetime_100ns(value: ::windows::Win32::Foundation::FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

unsafe fn query_command_line(handle: ::windows::Win32::Foundation::HANDLE) -> Option<String> {
    use ::windows::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessCommandLineInformation,
    };
    use ::windows::Win32::Foundation::UNICODE_STRING;

    let mut required = 0u32;
    let _ = unsafe {
        NtQueryInformationProcess(
            handle,
            ProcessCommandLineInformation,
            std::ptr::null_mut(),
            0,
            &mut required,
        )
    };
    if required < std::mem::size_of::<UNICODE_STRING>() as u32 || required > 1024 * 1024 {
        return None;
    }

    let word_size = std::mem::size_of::<usize>();
    let mut buffer = vec![0usize; (required as usize).div_ceil(word_size)];
    let status = unsafe {
        NtQueryInformationProcess(
            handle,
            ProcessCommandLineInformation,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * word_size) as u32,
            &mut required,
        )
    };
    if status.is_err() {
        return None;
    }

    let value = unsafe { std::ptr::read_unaligned(buffer.as_ptr().cast::<UNICODE_STRING>()) };
    let command_start = value.Buffer.0 as usize;
    let command_bytes = value.Length as usize;
    let buffer_start = buffer.as_ptr() as usize;
    let buffer_end = buffer_start.checked_add(buffer.len() * word_size)?;
    let command_end = command_start.checked_add(command_bytes)?;
    if !command_bytes.is_multiple_of(2)
        || command_start < buffer_start
        || command_end > buffer_end
        || command_start == 0
    {
        return None;
    }
    let units =
        unsafe { std::slice::from_raw_parts(command_start as *const u16, command_bytes / 2) };
    Some(String::from_utf16_lossy(units))
}
