//! Exercises the real ACP transport, durable records and turn checkpoints.
//! Only an owned temporary Git repository and a local fake NDJSON adapter run.
//! cargo run -p cc-panes --example agent_runtime_smoke -- /absolute/evidence/dir

#[cfg(unix)]
mod smoke {
    use cc_panes_lib::services::{AcpChatPhase, AcpChatService, AcpLaunchSpec, RunFilter};
    use cc_panes_lib::utils::AppResult;
    use serde_json::{json, Value};
    use std::net::{SocketAddr, TcpStream};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;
    use std::time::Duration;
    use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

    const BEFORE: &str = "before agent edit\n";
    const AFTER: &str = "after agent edit\n";

    struct Fixture {
        _temporary: tempfile::TempDir,
        repo: PathBuf,
        data: PathBuf,
        state: PathBuf,
        script: PathBuf,
        python: PathBuf,
    }

    fn ensure(condition: bool, message: impl Into<String>) -> AppResult<()> {
        if condition {
            Ok(())
        } else {
            Err(message.into().into())
        }
    }

    fn git(repo: &Path, arguments: &[&str]) -> AppResult<()> {
        let output = Command::new("git")
            .current_dir(repo)
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "user.name=Owned runtime fixture",
                "-c",
                "user.email=fixture@local.invalid",
            ])
            .args(arguments)
            .output()?;
        ensure(
            output.status.success(),
            format!(
                "fixture git failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        )
    }

    impl Fixture {
        fn new() -> AppResult<Self> {
            let temporary = tempfile::Builder::new()
                .prefix("cc-panes-agent-runtime-")
                .tempdir()?;
            let root = temporary.path().canonicalize()?;
            let repo = root.join("repository");
            let state = root.join("state");
            std::fs::create_dir(&repo)?;
            std::fs::create_dir(&state)?;
            git(&repo, &["init", "-q", "--template="])?;
            std::fs::write(repo.join("fixture.txt"), BEFORE)?;
            git(&repo, &["add", "fixture.txt"])?;
            git(&repo, &["commit", "-qm", "fixture baseline"])?;
            let script = root.join("owned_adapter.py");
            std::fs::write(
                &script,
                include_str!("../../scripts/fixtures/agent-runtime-adapter.py"),
            )?;
            let python = which::which("python3").map_err(|error| error.to_string())?;
            Ok(Self {
                _temporary: temporary,
                repo,
                data: root.join("data"),
                state,
                script,
                python,
            })
        }

        fn spec(&self, chat: &str, mode: &str) -> AcpLaunchSpec {
            AcpLaunchSpec {
                engine_id: "owned-runtime-fixture".into(),
                command: self.python.to_string_lossy().into(),
                args: vec![
                    self.script.to_string_lossy().into(),
                    "--adapter".into(),
                    mode.into(),
                    self.repo.to_string_lossy().into(),
                    self.state.join(chat).to_string_lossy().into(),
                ],
                cwd: self.repo.to_string_lossy().into(),
                mcp_servers: vec![],
                resume_acp_session_id: None,
                fork_acp_session_id: None,
                auto_approve_kinds: vec![],
            }
        }

        fn chats(&self) -> PathBuf {
            self.data.join("agent-chats")
        }
        fn marker(&self, chat: &str, kind: &str) -> PathBuf {
            self.state.join(format!("{chat}.{kind}.json"))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Failure cleanup is restricted to processes whose recorded PID and
            // current command both name this exact temporary fixture script.
            let Ok(entries) = std::fs::read_dir(&self.state) else {
                return;
            };
            for entry in entries.flatten() {
                let Ok(value) = read_json(&entry.path()) else {
                    continue;
                };
                let Some(pid) = value["pid"]
                    .as_i64()
                    .and_then(|pid| i32::try_from(pid).ok())
                else {
                    continue;
                };
                let output = Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "command="])
                    .output();
                if output.is_ok_and(|output| {
                    String::from_utf8_lossy(&output.stdout)
                        .contains(self.script.to_string_lossy().as_ref())
                }) {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        }
    }

    fn read_json(path: &Path) -> AppResult<Value> {
        serde_json::from_slice(&std::fs::read(path)?).map_err(|error| error.to_string().into())
    }

    async fn wait_for_file(path: &Path) -> AppResult<Value> {
        for _ in 0..200 {
            if path.exists() {
                return read_json(path);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Err(format!("fixture marker was not written: {}", path.display()).into())
    }

    async fn start(
        service: &AcpChatService,
        app: &AppHandle,
        fixture: &Fixture,
        chat: &str,
        mode: &str,
    ) -> AppResult<()> {
        let ready = service
            .start(app.clone(), chat.into(), fixture.spec(chat, mode))
            .await?;
        ensure(
            ready.phase == AcpChatPhase::Ready && ready.protocol_version == Some(1),
            "ACP initialize/session-new did not reach Ready",
        )
    }

    fn prompt(text: &str) -> Vec<Value> {
        vec![json!({"type":"text","text":text})]
    }

    async fn completed_run(service: &AcpChatService, chat: &str) -> AppResult<Value> {
        let page = service
            .list_run_records(RunFilter {
                chat_id: Some(chat.into()),
                ..Default::default()
            })
            .await?;
        ensure(
            page.runs.len() == 1,
            format!("expected one recorded turn for {chat}"),
        )?;
        let run = &page.runs[0];
        ensure(
            run.status != "running" && run.finished_at.is_some(),
            "recorded turn was left running",
        )?;
        ensure(
            run.recording_error.is_none(),
            format!("recording failed: {:?}", run.recording_error),
        )?;
        let events = service.read_run_events(run.id.clone(), 0).await?;
        ensure(
            !events.has_more && !events.events.is_empty(),
            "run events were not persisted",
        )?;
        Ok(json!({"run":run,"events":events}))
    }

    async fn edit_case(
        service: &Arc<AcpChatService>,
        app: &AppHandle,
        fixture: &Fixture,
    ) -> AppResult<Value> {
        let chat = "fixture-edit";
        start(service, app, fixture, chat, "edit").await?;
        let reason = service
            .prompt_and_wait(chat, prompt("Edit the owned fixture"))
            .await?;
        ensure(reason == "end_turn", "ACP turn did not end normally")?;
        ensure(
            std::fs::read_to_string(fixture.repo.join("fixture.txt"))? == AFTER,
            "client fs/write_text_file did not modify the repository",
        )?;
        let record = completed_run(service, chat).await?;
        let serialized = record["events"].to_string();
        ensure(
            serialized.contains("user_prompt")
                && serialized.contains("tool_call")
                && serialized.contains("Owned fixture edit finished.")
                && serialized.contains("turn_ended"),
            "prompt/tool/text/completion events are missing",
        )?;
        let checkpoints = service.checkpoint_service();
        let id = record["run"]["checkpointId"]
            .as_str()
            .ok_or("run has no checkpoint association")?;
        let review = checkpoints.review(id)?;
        ensure(
            review.can_restore && review.files.len() == 1,
            format!(
                "finished turn cannot be reviewed/restored: {:?}",
                review.blocked_reason
            ),
        )?;
        ensure(
            review.files[0].before_content.as_deref() == Some(BEFORE)
                && review.files[0].after_content.as_deref() == Some(AFTER),
            "before/after checkpoint content differs",
        )?;
        let restored = checkpoints.restore(id, &review.revision)?;
        ensure(
            std::fs::read_to_string(fixture.repo.join("fixture.txt"))? == BEFORE,
            "whole-turn restore did not restore the original file",
        )?;
        service.stop(chat).await?;
        Ok(
            json!({"runId":record["run"]["id"],"status":record["run"]["status"],"eventCount":record["run"]["eventCount"],"checkpointId":id,"restoredPaths":restored.restored_paths,"actualFileRestored":true,"journal":record,"checkpointReview":review}),
        )
    }

    fn assert_no_checkpoint_lease(service: &AcpChatService, fixture: &Fixture) -> AppResult<()> {
        let checkpoints = service.checkpoint_service();
        let record = checkpoints.begin(
            "fixture-lease-probe",
            &uuid::Uuid::new_v4().to_string(),
            &fixture.repo,
        )?;
        std::fs::write(fixture.repo.join("lease-probe.txt"), "owned lease probe\n")?;
        checkpoints.finish(&record.id, "completed")?;
        let review = checkpoints.review(&record.id)?;
        ensure(
            review.can_restore,
            format!(
                "stopped turn leaked a repository lease: {:?}",
                review.blocked_reason
            ),
        )?;
        checkpoints.restore(&record.id, &review.revision)?;
        Ok(())
    }

    async fn timeout_case(
        service: &Arc<AcpChatService>,
        app: &AppHandle,
        fixture: &Fixture,
        wait_for_prompt: bool,
    ) -> AppResult<Value> {
        let chat = if wait_for_prompt {
            "fixture-timeout-active"
        } else {
            "fixture-timeout-admission"
        };
        start(service, app, fixture, chat, "hold").await?;
        let waiter = tokio::time::timeout(
            Duration::from_millis(1),
            service.prompt_and_wait(chat, prompt("Hold until stopped")),
        )
        .await;
        ensure(
            waiter.is_err(),
            "the one-millisecond waiter did not time out",
        )?;
        if wait_for_prompt {
            wait_for_file(&fixture.marker(chat, "prompt")).await?;
        }
        tokio::time::timeout(Duration::from_secs(10), service.stop(chat))
            .await
            .map_err(|error| error.to_string())??;
        let page = service
            .list_run_records(RunFilter {
                chat_id: Some(chat.into()),
                ..Default::default()
            })
            .await?;
        ensure(
            page.runs
                .iter()
                .all(|run| run.status != "running" && run.finished_at.is_some()),
            "abandoned waiter left a running journal record",
        )?;
        if wait_for_prompt {
            ensure(
                page.runs.len() == 1,
                "owned prompt did not continue after waiter cancellation",
            )?;
        }
        let checkpoints = service.checkpoint_service().list(chat)?;
        ensure(
            checkpoints
                .iter()
                .all(|record| record.completed_at.is_some()),
            "abandoned waiter left an unfinished checkpoint",
        )?;
        assert_no_checkpoint_lease(service, fixture)?;
        ensure(
            service.snapshot(chat).await.is_none(),
            "stopped adapter is still registered",
        )?;
        Ok(
            json!({"waiterTimedOut":true,"waitedForActualPrompt":wait_for_prompt,"runs":page.runs,"checkpointCount":checkpoints.len(),"noActiveLease":true}),
        )
    }

    async fn wait_for_process_exit(pid: i32) -> AppResult<()> {
        for _ in 0..150 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Err(format!("owned fixture process {pid} survived stop").into())
    }

    async fn background_case(
        service: &Arc<AcpChatService>,
        app: &AppHandle,
        fixture: &Fixture,
    ) -> AppResult<Value> {
        let chat = "fixture-background";
        start(service, app, fixture, chat, "background").await?;
        service
            .prompt_and_wait(chat, prompt("Start owned fixture server"))
            .await?;
        let server = wait_for_file(&fixture.marker(chat, "server")).await?;
        let pid = server["pid"].as_i64().ok_or("missing server pid")? as i32;
        let address: SocketAddr = format!(
            "127.0.0.1:{}",
            server["port"].as_u64().ok_or("missing server port")?
        )
        .parse()
        .map_err(|error: std::net::AddrParseError| error.to_string())?;
        ensure(
            TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok(),
            "owned background server is not reachable",
        )?;
        ensure(
            service.has_background_tools_in(&fixture.repo).await,
            "managed background process was not registered",
        )?;
        let record = completed_run(service, chat).await?;
        let id = record["run"]["checkpointId"]
            .as_str()
            .ok_or("background run has no checkpoint")?;
        let review = service.checkpoint_service().review(id)?;
        ensure(
            !review.can_restore
                && review
                    .blocked_reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("background")),
            "background writes did not block checkpoint restore",
        )?;
        ensure(
            service
                .checkpoint_service()
                .restore(id, &review.revision)
                .is_err(),
            "unsafe background checkpoint was restored",
        )?;
        tokio::time::timeout(Duration::from_secs(10), service.stop(chat))
            .await
            .map_err(|error| error.to_string())??;
        wait_for_process_exit(pid).await?;
        ensure(
            !service.has_background_tools_in(&fixture.repo).await
                && TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_err(),
            "background server remains after stop",
        )?;
        Ok(
            json!({"runId":record["run"]["id"],"checkpointId":id,"restoreBlocked":true,"reason":review.blocked_reason,"serverPid":pid,"serverPort":address.port(),"serverReaped":true}),
        )
    }

    async fn cases(
        service: &Arc<AcpChatService>,
        app: &AppHandle,
        fixture: &Fixture,
    ) -> AppResult<Value> {
        let edit = edit_case(service, app, fixture).await?;
        let timeout_admission = timeout_case(service, app, fixture, false).await?;
        let timeout_active = timeout_case(service, app, fixture, true).await?;
        let background = background_case(service, app, fixture).await?;
        Ok(
            json!({"editAndRestore":edit,"droppedAdmissionWaiter":timeout_admission,
                  "droppedActiveWaiter":timeout_active,"backgroundServer":background}),
        )
    }

    async fn run(app: AppHandle) -> AppResult<Value> {
        let fixture = Fixture::new()?;
        let service = Arc::new(AcpChatService::new(fixture.chats()));
        let result =
            tokio::time::timeout(Duration::from_secs(60), cases(&service, &app, &fixture)).await;
        let cleanup = tokio::time::timeout(Duration::from_secs(10), service.cleanup_all()).await;
        ensure(cleanup.is_ok(), "fixture cleanup timed out")?;
        let mut report = result.map_err(|error| error.to_string())??;
        drop(service);
        let reopened = AcpChatService::new(fixture.chats());
        let records = reopened.list_run_records(RunFilter::default()).await?;
        ensure(
            records.runs.len() >= 3 && records.runs.iter().all(|record| record.status != "running"),
            "offline service rebuild lost history or left live runs",
        )?;
        let original = completed_run(&reopened, "fixture-edit").await?;
        ensure(
            original["events"]
                .to_string()
                .contains("Owned fixture edit finished."),
            "offline rebuild lost transcript events",
        )?;
        report["offlineReopen"] = json!({"runCount":records.runs.len(),"transcriptRetained":true,"noRunningRecords":true});
        report["success"] = true.into();
        Ok(report)
    }

    async fn report_and_exit(app: AppHandle, output: PathBuf) {
        let report = match run(app.clone()).await {
            Ok(report) => report,
            Err(error) => json!({"success":false,"error":error.to_string()}),
        };
        let status = if report["success"] == true { 0 } else { 1 };
        let serialized =
            serde_json::to_string_pretty(&report).expect("serialize owned fixture report");
        if let Err(error) = std::fs::write(output.join("agent-runtime-smoke.json"), &serialized) {
            eprintln!("cannot write fixture report: {error}");
        }
        println!("{serialized}");
        app.exit(status);
    }

    pub fn main() {
        let output = std::env::args()
            .nth(1)
            .map(PathBuf::from)
            .expect("provide an evidence directory");
        std::fs::create_dir_all(&output).expect("create evidence directory");
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = "com.ccpanes.agent-runtime-acceptance".into();
        context.config_mut().app.windows.clear();
        tauri::Builder::default()
            .setup(move |app| {
                WebviewWindowBuilder::new(
                    app,
                    "main",
                    WebviewUrl::External("about:blank".parse()?),
                )
                .title("CC-Panes owned Agent runtime fixture")
                .visible(false)
                .build()?;
                tauri::async_runtime::spawn(report_and_exit(app.handle().clone(), output));
                Ok(())
            })
            .run(context)
            .expect("run owned Agent runtime fixture");
    }
}

fn main() {
    #[cfg(unix)]
    smoke::main();
    #[cfg(not(unix))]
    eprintln!("agent_runtime_smoke currently uses a Unix Python fixture");
}
