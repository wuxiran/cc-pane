use super::*;

/// Owns just the newly created child until all essential I/O/wait threads exist.
/// A failed OS thread allocation must roll back that launch, not crash other panes.
pub(super) struct LaunchThreadGuard<'a> {
    service: &'a TerminalService,
    session_id: String,
    process: Arc<dyn PtyProcess>,
    armed: bool,
}

impl<'a> LaunchThreadGuard<'a> {
    pub(super) fn new(
        service: &'a TerminalService,
        session_id: &str,
        process: Arc<dyn PtyProcess>,
    ) -> Self {
        Self {
            service,
            session_id: session_id.to_owned(),
            process,
            armed: true,
        }
    }
    pub(super) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for LaunchThreadGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(session) = self
            .service
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.session_id)
        {
            session.cancelled.store(true, Ordering::Release);
            session.output_flow.release();
            if let Some(cleanup) = session.managed_pi_state_cleanup {
                cleanup.cleanup();
            }
            if let Some(cleanup) = session.managed_wsl_pi_state_cleanup {
                cleanup.cleanup();
            }
        }
        self.service
            .input_mutexes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.session_id);
        if let Err(error) = self.process.kill() {
            error!(%error, session_id = %self.session_id, "failed-launch child kill failed");
        }
        self.process.close_output();
        if let Err(error) = self.process.wait() {
            error!(%error, session_id = %self.session_id, "failed-launch child reap failed");
        }
        wsl_codex::cleanup_session_mcp_configs(self.service.app_paths.data_dir(), &self.session_id);
    }
}

pub(super) fn spawn_error(stage: &str, error: std::io::Error) -> anyhow::Error {
    anyhow::Error::new(AppError::coded("TERMINAL_THREAD_START_FAILED", format!("Cannot start terminal {stage} thread: {error}. The new launch was stopped; existing sessions remain running.")))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Process(std::sync::atomic::AtomicUsize);
    impl PtyProcess for Process {
        fn resize(&self, _: u16, _: u16) -> Result<()> {
            Ok(())
        }
        fn pid(&self) -> u32 {
            0
        }
        fn kill(&self) -> Result<()> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn wait(&self) -> Result<std::process::ExitStatus> {
            self.0.fetch_add(10, Ordering::SeqCst);
            #[cfg(unix)]
            use std::os::unix::process::ExitStatusExt;
            #[cfg(windows)]
            use std::os::windows::process::ExitStatusExt;
            Ok(std::process::ExitStatus::from_raw(0))
        }
    }

    #[test]
    fn issue64_failed_thread_rolls_back_only_new_launch_and_reaps_child() {
        let (service, _dir) = super::super::tests::terminal_service_for_test();
        let process = Arc::new(Process(std::sync::atomic::AtomicUsize::new(0)));
        {
            let _guard = LaunchThreadGuard::new(&service, "fixture", process.clone());
            crate::pty::thread::fail_next_spawn();
            assert!(spawn_terminal_writer("fixture".into(), Box::new(std::io::sink())).is_err());
        }
        assert_eq!(process.0.load(Ordering::SeqCst), 11);
        assert!(service.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn issue64_partial_start_failure_releases_channels_and_keeps_other_sessions() {
        for stage in ["batch", "reader", "wait"] {
            let (service, _dir) = super::super::tests::terminal_service_for_test();
            for id in ["existing", "new"] {
                super::super::tests::install_recording_session(
                    &service,
                    id,
                    Arc::new(Mutex::new(Vec::new())),
                );
            }
            let process = Arc::new(Process(std::sync::atomic::AtomicUsize::new(0)));
            let (cancelled, flow) = {
                let mut sessions = service.sessions.lock().unwrap();
                let session = sessions.get_mut("new").unwrap();
                session.process = process.clone();
                (session.cancelled.clone(), session.output_flow.clone())
            };
            let (tx, rx) = mpsc::channel::<()>();
            let finished = crate::pty::thread::spawn_named("started-sibling", move || {
                assert!(rx.recv_timeout(Duration::from_secs(3)).is_err());
            })
            .unwrap();
            {
                let _guard = LaunchThreadGuard::new(&service, "new", process.clone());
                crate::pty::thread::fail_next_spawn();
                assert!(crate::pty::thread::spawn_named(stage, move || drop(tx)).is_err());
            }
            finished.join().unwrap();
            assert_eq!(process.0.load(Ordering::SeqCst), 11);
            assert!(cancelled.load(Ordering::Acquire));
            // Released gates must not keep an already-started PTY reader parked.
            assert!(matches!(
                flow.park_if_paused(&cancelled),
                ParkOutcome::NotParked
            ));
            assert!(service.sessions.lock().unwrap().contains_key("existing"));
            assert!(!service.sessions.lock().unwrap().contains_key("new"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn issue64_failed_thread_reaps_only_its_isolated_windows_pty() {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let (service, dir) = super::super::tests::terminal_service_for_test();
        for stage in ["writer", "batch", "reader", "wait"] {
            let spawned = spawn_pty(PtyConfig {
                cols: 80,
                rows: 24,
                cwd: dir.path().to_owned(),
                command: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
                args: vec![
                    "/D".into(),
                    "/Q".into(),
                    "/C".into(),
                    "set /p issue64_fixture=".into(),
                ],
                env: HashMap::new(),
                env_remove: Vec::new(),
                resource_policy: Default::default(),
            })
            .unwrap();
            let handle =
                unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, spawned.process.pid()) }.unwrap();
            {
                let _guard = LaunchThreadGuard::new(&service, "windows-fixture", spawned.process);
                // Ownership ordering mirrors the production launch: pipes close before ConPTY.
                let _reader = spawned.reader;
                let _writer = spawned.writer;
                crate::pty::thread::fail_next_spawn();
                assert!(crate::pty::thread::spawn_named(stage, || {}).is_err());
            }
            let result = unsafe { WaitForSingleObject(handle, 3_000) };
            unsafe { CloseHandle(handle) }.unwrap();
            assert_eq!(
                result.0, 0,
                "failed {stage} launch left its PTY process alive"
            );
        }
    }
}
