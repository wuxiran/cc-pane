//! Regression tests use bounded, isolated child commands; no agent CLI or user
//! processes are involved. AcpProcess's cancellation guard also cleans up panic paths.
use super::*;

#[cfg(unix)]
async fn start_running(manager: &AcpTerminalManager) -> (Value, Arc<AcpTerminal>) {
    let params = json!({"command": "sh", "args": ["-c", "sleep 30 & printf ready; wait"]});
    let id = manager
        .create(&params, &std::env::temp_dir(), Arc::new(|_| {}))
        .await
        .unwrap();
    let terminal = manager.get(&id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while terminal.output_json().await["output"] != "ready" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("isolated child did not start");
    (id, terminal)
}

#[cfg(unix)]
#[tokio::test]
async fn kill_interrupts_a_child_that_is_already_being_waited_on() {
    let manager = AcpTerminalManager::default();
    let (id, terminal) = start_running(&manager).await;
    let result = tokio::time::timeout(Duration::from_secs(3), manager.kill(&id)).await;
    assert!(result.expect("kill did not complete").is_ok());
    let exit = terminal.wait_for_exit().await;
    assert_eq!(exit["signal"], "SIGKILL");
    let output = manager.output(&id).await.unwrap();
    assert_eq!(output["output"], "ready");
    assert_eq!(output["exitStatus"], exit);
    manager.release_all().await;
}

#[cfg(unix)]
#[tokio::test]
async fn release_and_shutdown_wait_for_termination_and_close_creation() {
    let manager = AcpTerminalManager::default();
    let (id, released) = start_running(&manager).await;
    tokio::time::timeout(Duration::from_secs(3), manager.release(&id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(released.wait_for_exit().await["signal"], "SIGKILL");
    assert!(manager.output(&id).await.is_err());
    let (_, closed) = start_running(&manager).await;
    tokio::time::timeout(Duration::from_secs(3), manager.release_all())
        .await
        .unwrap();
    assert_eq!(closed.wait_for_exit().await["signal"], "SIGKILL");
    let result = manager
        .create(
            &json!({"command":"sh","args":["-c","exit 0"]}),
            &std::env::temp_dir(),
            Arc::new(|_| {}),
        )
        .await;
    assert_eq!(result.unwrap_err()["message"], "ACP session is closed");
}

#[cfg(unix)]
#[tokio::test]
async fn terminal_exit_waits_for_complete_output_and_preserves_exit_code() {
    let manager = AcpTerminalManager::default();
    let params = json!({"command":"sh", "args":["-c", "dd if=/dev/zero bs=65536 count=16 2>/dev/null; printf tail; exit 7"], "outputByteLimit": 2 * 1024 * 1024});
    let id = manager
        .create(&params, &std::env::temp_dir(), Arc::new(|_| {}))
        .await
        .unwrap();
    let exit = tokio::time::timeout(Duration::from_secs(5), manager.wait_for_exit(&id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(exit["exitCode"], 7);
    let output = manager.output(&id).await.unwrap();
    let text = output["output"].as_str().unwrap();
    assert_eq!(text.len(), 1024 * 1024 + 4);
    assert!(text.ends_with("tail"));
    assert_eq!(output["truncated"], false);
    manager.release_all().await;
}

#[cfg(unix)]
#[tokio::test]
async fn simultaneous_create_and_close_cannot_leave_registered_or_running_children() {
    let manager = Arc::new(AcpTerminalManager::default());
    let barrier = Arc::new(tokio::sync::Barrier::new(13));
    let dir = tempfile::tempdir().unwrap();
    let mut tasks = JoinSet::new();
    for _ in 0..12 {
        let manager = manager.clone();
        let barrier = barrier.clone();
        let path = dir.path().to_path_buf();
        tasks.spawn(async move {
            barrier.wait().await;
            manager.create(&json!({"command":"sh","args":["-c", ": > \"$1/$$.pid\"; sleep 30", "probe", path]}), &std::env::temp_dir(), Arc::new(|_|{})).await
        });
    }
    barrier.wait().await;
    manager.release_all().await;
    while let Some(result) = tasks.join_next().await {
        if let Err(error) = result.unwrap() {
            assert_eq!(error["message"], "ACP session is closed");
        }
    }
    let registry = manager.terminals.read().await;
    assert!(registry.closed);
    assert!(registry.entries.is_empty());
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        // Closing can kill the shell between opening a file and writing its
        // contents. Put the PID in the atomically created filename instead.
        let pid: i32 = entry
            .unwrap()
            .path()
            .file_stem()
            .unwrap()
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        // The child owner has waited/reaped before release_all returns.
        assert_ne!(
            unsafe { libc::kill(pid, 0) },
            0,
            "probe child {pid} survived close"
        );
    }
}
