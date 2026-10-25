use super::*;
use std::collections::HashSet;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::time::Instant;

// Accommodate the existing 10 MiB attachment limit after base64 expansion.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_PENDING: usize = 256;
const EVENT_CAPACITY: usize = 258;
const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);
type Reply = oneshot::Sender<AppResult<Value>>;

pub(super) enum Operation {
    Request {
        method: String,
        params: Value,
    },
    Notify {
        method: String,
        params: Value,
    },
    Response {
        id: Value,
        result: Result<Value, Value>,
    },
}

pub(super) enum Command {
    Operation(Operation, Reply),
}

pub(super) async fn spawn(
    options: &CodexAppServerOptions,
) -> AppResult<(CodexAppServer, mpsc::Receiver<CodexAppServerEvent>)> {
    if !options.cwd.is_dir()
        || options.request_timeout.is_zero()
        || options.request_timeout > Duration::from_secs(300)
    {
        return Err(AppError::coded(
            "CODEX_APP_SERVER_CONFIG",
            "A directory and a request timeout between 0 and 300 seconds are required",
        ));
    }
    let executable = options
        .executable
        .as_deref()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "codex".into());
    let executable = cc_cli_adapters::resolve_executable(&executable)
        .map_err(|error| AppError::coded("CODEX_APP_SERVER_EXECUTABLE", error.to_string()))?;
    let mut arguments = Vec::new();
    for config in &options.config_overrides {
        arguments.extend(["-c".to_owned(), config.clone()]);
    }
    arguments.extend(options.arguments.iter().cloned());
    let (executable, arguments) = cc_cli_adapters::rewrite_windows_npm_shim(
        executable.to_string_lossy().into_owned(),
        arguments,
    );
    let mut command = crate::utils::no_window_tokio_command(executable);
    command
        .args(arguments)
        .current_dir(&options.cwd)
        .envs(&options.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    process::configure(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| AppError::coded("CODEX_APP_SERVER_SPAWN", error.to_string()))?;
    let pid = child.id().ok_or_else(closed)?;
    let stdin = child.stdin.take().ok_or_else(closed)?;
    let stdout = child.stdout.take().ok_or_else(closed)?;
    let stderr = child.stderr.take().ok_or_else(closed)?;
    let process = process::Process::new(child).await?;
    let (commands, receiver) = mpsc::channel(64);
    let (events, event_receiver) = mpsc::channel(EVENT_CAPACITY);
    let (stop, stopping) = watch::channel(false);
    let (completed, completion) = watch::channel(None);
    let client = CodexAppServer {
        inner: Arc::new(ClientInner {
            commands,
            request_timeout: options.request_timeout,
            pid,
            stop,
            completion,
        }),
    };
    let actor = Actor {
        stdin: Some(stdin),
        pending: HashMap::new(),
        server_requests: HashSet::new(),
        next_id: 1,
        events,
        timeout: options.request_timeout,
        stop: stopping,
    };
    tokio::spawn(actor.run(receiver, stdout, stderr, process, completed));
    Ok((client, event_receiver))
}

struct Pending {
    reply: Reply,
    deadline: Instant,
}

struct Actor {
    stdin: Option<ChildStdin>,
    pending: HashMap<u64, Pending>,
    server_requests: HashSet<String>,
    next_id: u64,
    events: mpsc::Sender<CodexAppServerEvent>,
    timeout: Duration,
    stop: watch::Receiver<bool>,
}

impl Actor {
    async fn run(
        mut self,
        mut commands: mpsc::Receiver<Command>,
        stdout: tokio::process::ChildStdout,
        mut stderr: tokio::process::ChildStderr,
        process: process::Process,
        completed: watch::Sender<Option<AppResult<()>>>,
    ) {
        let mut stdout = FrameReader::new(stdout);
        let mut stderr_buffer = [0u8; 4096];
        let mut stderr_open = true;
        let mut tick = tokio::time::interval(Duration::from_millis(25));
        let failure = loop {
            if *self.stop.borrow() {
                break None;
            }
            tokio::select! {
                command = commands.recv() => match command {
                    Some(Command::Operation(operation, reply)) => {
                        if let Err(error) = self.operation(operation, reply).await { break Some(error); }
                    },
                    None => break None,
                },
                frame = stdout.next() => match frame {
                    Ok(Some(frame)) => if let Err(error) = self.frame(&frame) { break Some(error); },
                    Ok(None) => break None,
                    Err(error) => break Some(error),
                },
                read = stderr.read(&mut stderr_buffer), if stderr_open => {
                    // Drain stderr without echoing potentially sensitive config,
                    // prompts or credential-provider diagnostics into the UI.
                    if !matches!(read, Ok(size) if size > 0) { stderr_open = false; }
                },
                _ = tick.tick() => self.expire(),
                _ = self.events.closed() => break None,
                _ = self.stop.changed() => break None,
            }
        };
        // A requested shutdown may cancel a pending write; that is a normal
        // lifecycle transition, not a protocol violation to show in the UI.
        let failure = if *self.stop.borrow() { None } else { failure };
        commands.close();
        let error = failure.clone().unwrap_or_else(closed);
        if let Some(failure) = failure {
            let _ = self.events.try_send(CodexAppServerEvent::ProtocolError {
                message: failure.to_string(),
            });
        }
        for (_, pending) in self.pending.drain() {
            let _ = pending.reply.send(Err(error.clone()));
        }
        while let Ok(command) = commands.try_recv() {
            match command {
                Command::Operation(_, reply) => {
                    let _ = reply.send(Err(error.clone()));
                }
            }
        }
        self.stdin.take();
        let status = match tokio::time::timeout(SHUTDOWN_GRACE, process.wait()).await {
            Ok(status) => status,
            Err(_) => process.stop().await,
        };
        let _ = self.events.try_send(CodexAppServerEvent::Exited {
            code: status.as_ref().ok().and_then(|status| status.code()),
        });
        completed.send_replace(Some(status.map(|_| ()).map_err(AppError::from)));
    }

    async fn operation(&mut self, operation: Operation, reply: Reply) -> AppResult<()> {
        if reply.is_closed() {
            return Ok(());
        }
        match operation {
            Operation::Request { method, params } => {
                self.expire();
                if self.pending.len() >= MAX_PENDING {
                    let _ = reply.send(Err(AppError::coded(
                        "CODEX_APP_SERVER_BUSY",
                        "Too many pending Codex requests",
                    )));
                    return Ok(());
                }
                let id = self.next_id;
                self.next_id += 1;
                self.pending.insert(
                    id,
                    Pending {
                        reply,
                        deadline: Instant::now() + self.timeout,
                    },
                );
                self.write(json!({"id": id, "method": method, "params": params}))
                    .await
            }
            Operation::Notify { method, params } => {
                let result = self
                    .write(json!({"method": method, "params": params}))
                    .await;
                let _ = reply.send(result.clone().map(|_| Value::Null));
                result
            }
            Operation::Response { id, result } => self.response(id, result, reply).await,
        }
    }

    async fn response(
        &mut self,
        id: Value,
        result: Result<Value, Value>,
        reply: Reply,
    ) -> AppResult<()> {
        let key = id.to_string();
        if !self.server_requests.contains(&key) {
            let _ = reply.send(Err(AppError::coded(
                "CODEX_APP_SERVER_STALE_REQUEST",
                "Codex request is no longer pending",
            )));
            return Ok(());
        }
        let frame = match result {
            Ok(result) => json!({"id": id, "result": result}),
            Err(error) => json!({"id": id, "error": error}),
        };
        let result = self.write(frame).await;
        if result.is_ok() {
            self.server_requests.remove(&key);
        }
        let _ = reply.send(result.clone().map(|_| Value::Null));
        result
    }

    async fn write(&mut self, frame: Value) -> AppResult<()> {
        let mut bytes = serde_json::to_vec(&frame).map_err(|error| protocol(error.to_string()))?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(protocol("Codex request exceeded the 16 MiB frame limit"));
        }
        bytes.push(b'\n');
        let stdin = self.stdin.as_mut().ok_or_else(closed)?;
        tokio::time::timeout(self.timeout, async {
            tokio::select! {
                result = async { stdin.write_all(&bytes).await?; stdin.flush().await } => result,
                _ = self.stop.changed() => Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "Codex is shutting down")),
            }
        })
        .await
        .map_err(|_| protocol("Codex stdin write timed out"))?
        .map_err(|error| protocol(format!("Codex stdin failed: {error}")))
    }

    fn frame(&mut self, bytes: &[u8]) -> AppResult<()> {
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        let frame: Value = serde_json::from_slice(bytes)
            .map_err(|_| protocol("Codex sent invalid JSON on stdout"))?;
        if let Some(method) = frame.get("method").and_then(Value::as_str) {
            let params = frame.get("params").cloned().unwrap_or(Value::Null);
            if method == "serverRequest/resolved" && frame.get("id").is_none() {
                if let Some(id) = params.get("requestId") {
                    self.server_requests.remove(&id.to_string());
                }
            }
            let event = if let Some(id) = frame.get("id") {
                if !(id.is_string() || id.is_i64() || id.is_u64()) {
                    return Err(protocol("Codex server request has an invalid ID"));
                }
                if self.server_requests.len() >= MAX_PENDING
                    || !self.server_requests.insert(id.to_string())
                {
                    return Err(protocol(
                        "Codex has too many pending or duplicate server requests",
                    ));
                }
                CodexAppServerEvent::ServerRequest {
                    id: id.clone(),
                    method: method.into(),
                    params,
                }
            } else {
                CodexAppServerEvent::Notification {
                    method: method.into(),
                    params,
                }
            };
            self.event(event)
        } else {
            self.response_frame(&frame)
        }
    }

    fn response_frame(&mut self, frame: &Value) -> AppResult<()> {
        let id = frame
            .get("id")
            .and_then(Value::as_u64)
            .ok_or_else(|| protocol("Codex response is missing its numeric request ID"))?;
        if frame.get("result").is_some() == frame.get("error").is_some() {
            return Err(protocol(
                "Codex response must contain exactly one result or error",
            ));
        }
        // Late replies to cancelled or timed-out requests are expected.
        let Some(pending) = self.pending.remove(&id) else {
            return Ok(());
        };
        let result = match frame.get("error") {
            Some(error) => Err(AppError::coded(
                "CODEX_APP_SERVER_RPC_ERROR",
                error.to_string(),
            )),
            None => Ok(frame["result"].clone()),
        };
        let _ = pending.reply.send(result);
        Ok(())
    }

    fn event(&self, event: CodexAppServerEvent) -> AppResult<()> {
        // Reserve two slots for an explicit overflow error and process exit.
        // A lost approval/final notification is never presented as success.
        if self.events.capacity() <= 2 {
            return Err(protocol(
                "Codex event consumer is too slow; connection closed to avoid losing events",
            ));
        }
        self.events.try_send(event).map_err(|_| closed())
    }

    fn expire(&mut self) {
        let now = Instant::now();
        let expired: Vec<u64> = self
            .pending
            .iter()
            .filter_map(|(&id, pending)| {
                (pending.reply.is_closed() || pending.deadline <= now).then_some(id)
            })
            .collect();
        for id in expired {
            if let Some(pending) = self.pending.remove(&id) {
                let _ = pending.reply.send(Err(AppError::coded(
                    "CODEX_APP_SERVER_TIMEOUT",
                    "Codex App Server request timed out",
                )));
            }
        }
    }
}

fn protocol(message: impl Into<String>) -> AppError {
    AppError::coded("CODEX_APP_SERVER_PROTOCOL", message)
}

/// Cancellation-safe bounded framing: bytes already consumed remain in self
/// when another select branch wins, including a command arriving mid-frame.
struct FrameReader<R> {
    reader: BufReader<R>,
    bytes: Vec<u8>,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader: BufReader::new(reader),
            bytes: Vec::new(),
        }
    }

    async fn next(&mut self) -> AppResult<Option<Vec<u8>>> {
        loop {
            let available = self.reader.fill_buf().await.map_err(AppError::from)?;
            if available.is_empty() {
                return if self.bytes.is_empty() {
                    Ok(None)
                } else {
                    Err(protocol("Codex stdout ended in a partial JSON frame"))
                };
            }
            let newline = available.iter().position(|&byte| byte == b'\n');
            let count = newline.map_or(available.len(), |index| index + 1);
            if self.bytes.len() + count > MAX_FRAME_BYTES {
                return Err(protocol("Codex stdout exceeded the 16 MiB frame limit"));
            }
            self.bytes.extend_from_slice(&available[..count]);
            self.reader.consume(count);
            if newline.is_some() {
                return Ok(Some(std::mem::take(&mut self.bytes)));
            }
        }
    }
}
