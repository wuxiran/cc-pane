// Included inside job::tests so the existing test filter and namespace stay stable.
const JOB_MEMORY_FIXTURE_DIR: &str = "CCPANES_JOB_MEMORY_FIXTURE_DIR";

fn wait_for_memory_fixture_marker(marker: &std::path::Path, phase: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !marker.exists() {
        assert!(
            Instant::now() < deadline,
            "memory fixture timed out waiting for {phase}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The parent opts this one exact test into child mode; normal test runs do no work.
#[test]
fn memory_notify_child_fixture() {
    let Some(directory) = std::env::var_os(JOB_MEMORY_FIXTURE_DIR) else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    std::fs::write(directory.join("started"), b"started").expect("fixture startup marker");
    wait_for_memory_fixture_marker(&directory.join("go"), "allocation permission");
    let mut memory = vec![0u8; 128 * 1024 * 1024];
    for page in memory.chunks_mut(4096) {
        page[0] = std::hint::black_box(0xA5);
    }
    std::hint::black_box(&memory);
    std::fs::write(directory.join("allocated"), b"allocated").expect("fixture allocation marker");
    wait_for_memory_fixture_marker(&directory.join("release"), "release");
    std::hint::black_box(&memory);
}

/// 第四段：64 MB 通知水位，确认子进程分配 128 MB 后在 3 s 内收到内核越线事件。
/// 用握手分离启动/分配耗时；子进程持有数组直到释放，验证通知型限制不会让分配失败。
#[test]
fn memory_notify_limit_fires_event_without_failing_allocation() {
    use std::sync::mpsc;
    let directory = tempfile::tempdir().expect("memory probe directory");
    let allocated = directory.path().join("allocated");
    let release = directory.path().join("release");
    let stderr_path = directory.path().join("stderr.txt");
    let executable = std::env::current_exe().expect("current Rust test executable");
    assert!(
        executable.is_absolute(),
        "test executable path must be absolute"
    );
    let mut child = Command::new(executable)
        .args([
            "--exact",
            "pty::job::tests::memory_notify_child_fixture",
            "--test-threads=1",
            "--nocapture",
        ])
        .env(JOB_MEMORY_FIXTURE_DIR, directory.path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::fs::File::create(&stderr_path).expect("probe stderr"))
        .spawn()
        .expect("spawn Rust memory fixture");
    let mut job = None;
    let mut phase = "configure job";
    let checks = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let (tx, rx) = mpsc::channel();
        let callback: JobMemoryCallback = Arc::new(move |event| {
            let _ = tx.send((Instant::now(), event));
        });
        let policy = SessionResourcePolicy {
            lower_priority: false,
            cpu_weight: None,
            eco_qos: false,
            memory_notify_bytes: Some(64 * 1024 * 1024),
        };
        let (created, outcome) =
            ProcessJob::create_for_with_policy(child.id(), &policy, Some(callback))
                .expect("create job");
        job = Some(created);
        assert_eq!(outcome, PolicyOutcome::Applied, "notify limit should apply");
        phase = "Rust fixture startup and allocation";
        std::fs::write(directory.path().join("go"), b"go").expect("start allocation");
        let deadline = Instant::now() + Duration::from_secs(15);
        while !allocated.exists() {
            let status = child.try_wait().expect("allocation child status");
            assert!(
                status.is_none(),
                "child exited before allocation: {status:?}"
            );
            assert!(
                Instant::now() < deadline,
                "allocation handshake timed out (child started: {})",
                directory.path().join("started").exists()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        phase = "memory notification";
        let (_, event) = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("memory notify event within 3s after allocation");
        assert_eq!(event.limit_bytes, 64 * 1024 * 1024);
        assert!(
            event.bytes > 64 * 1024 * 1024,
            "kernel-reported bytes should exceed the limit: {}",
            event.bytes
        );
        phase = "debounce and survival";
        // Count callback time, not queued pre-allocation notifications.
        let mut extra = 0usize;
        let window_start = Instant::now();
        let until = window_start + Duration::from_millis(1500);
        while Instant::now() < until {
            if let Ok((fired_at, _)) = rx.recv_timeout(Duration::from_millis(50)) {
                if fired_at >= window_start && fired_at < until {
                    extra += 1;
                }
            }
        }
        // If the test thread was descheduled, include callbacks queued in
        // this window even when the receiver resumes after its deadline.
        extra += rx
            .try_iter()
            .filter(|(fired_at, _)| *fired_at >= window_start && *fired_at < until)
            .count();
        assert!(extra <= 1, "debounce leaked {extra} callbacks within 1.5s");
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "child must survive"
        );
        phase = "job flags and rearm";
        let job = job.as_ref().expect("configured job");
        let flags = query_limit_flags(job);
        assert_ne!(flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0, 0);
        job.rearm_memory_notify().expect("rearm");
    }));
    let status_before_cleanup = child.try_wait();
    let released = std::fs::write(release, b"release");
    drop(job);
    let _ = child.kill();
    let reaped = child.wait();
    if let Err(panic) = checks {
        let stderr = std::fs::read(&stderr_path).unwrap_or_default();
        eprintln!("Memory probe failed during {phase}; status: {status_before_cleanup:?}; release: {released:?}; reaped: {reaped:?}; stderr: {}", String::from_utf8_lossy(&stderr));
        std::panic::resume_unwind(panic);
    }
    released.expect("release memory probe");
    reaped.expect("reap memory probe");
}
