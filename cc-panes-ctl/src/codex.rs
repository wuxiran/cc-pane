//! Native Codex App Server CLI. Does not depend on the CC-Panes desktop daemon.
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::time::Duration;

use cc_panes_core::services::codex_app_server::{
    CodexAppServer, CodexAppServerEvent, CodexAppServerOptions,
};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::cli::CliExit;

mod interaction;
#[cfg(test)]
mod tests;

#[derive(Debug, Subcommand)]
pub enum CodexCommand {
    /// List models advertised by the installed Codex App Server.
    Models,
    /// List saved Codex threads (does not resume or modify them).
    Threads {
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Run one turn, streaming output. Ctrl-C interrupts only this turn.
    Run(RunArgs),
}

#[derive(Debug, Args)]
pub struct RunArgs {
    /// Task text. Quote it as one argument.
    pub prompt: String,
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// Continue a saved thread. Do not resume a thread already running elsewhere.
    #[arg(long, conflicts_with = "fork")]
    pub resume: Option<String>,
    /// Copy a saved thread into a new conversation before running.
    #[arg(long, conflicts_with = "resume")]
    pub fork: Option<String>,
    #[arg(long)]
    pub model: Option<String>,
    /// Filesystem access; additional access still requires explicit approval.
    #[arg(long, value_enum, default_value_t = Sandbox::WorkspaceWrite)]
    pub sandbox: Sandbox,
    /// Maximum turn duration in seconds (including waiting for user input).
    #[arg(long, default_value_t = 1800, value_parser = clap::value_parser!(u64).range(1..=86400))]
    pub timeout: u64,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Sandbox {
    ReadOnly,
    WorkspaceWrite,
}

impl Sandbox {
    fn wire(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
        }
    }
}

fn failure(error: impl std::fmt::Display) -> CliExit {
    CliExit::source(error.to_string())
}

pub fn execute(command: CodexCommand, machine: bool) -> Result<(), CliExit> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(failure)?;
    runtime.block_on(execute_async(command, machine))
}

fn workspace(path: PathBuf) -> Result<PathBuf, CliExit> {
    let path = std::fs::canonicalize(path).map_err(failure)?;
    if !path.is_dir() {
        return Err(CliExit::argument("Codex cwd must be a directory"));
    }
    Ok(path)
}

async fn execute_async(command: CodexCommand, machine: bool) -> Result<(), CliExit> {
    let cwd = match &command {
        CodexCommand::Run(args) => workspace(args.cwd.clone())?,
        CodexCommand::Threads { cwd: Some(cwd), .. } => workspace(cwd.clone())?,
        _ => std::env::current_dir().map_err(failure)?,
    };
    if matches!(&command, CodexCommand::Run(args) if args.prompt.trim().is_empty()) {
        return Err(CliExit::argument("Codex prompt must not be empty"));
    }
    let options = CodexAppServerOptions {
        cwd: cwd.clone(),
        client_name: "cc-panes-ctl".into(),
        ..Default::default()
    };
    let (client, mut events) = tokio::select! {
        result = CodexAppServer::spawn(options) => result.map_err(failure)?,
        signal = tokio::signal::ctrl_c() => { signal.map_err(failure)?; return Err(CliExit::silent(130)); }
    };
    let active_turn = std::sync::Mutex::new(None);
    let result = tokio::select! {
        result = dispatch(&client, &mut events, command, cwd, machine, &active_turn) => result,
        signal = tokio::signal::ctrl_c() => {
            signal.map_err(failure)?;
            let active = active_turn.lock().expect("active Codex turn").clone();
            if let Some((thread, turn)) = active { interrupt(&client, &thread, &turn).await; }
            Err(CliExit::silent(130))
        }
    };
    let cleanup = client.shutdown().await.map_err(failure);
    result.and(cleanup)
}

async fn dispatch(
    client: &CodexAppServer,
    events: &mut mpsc::Receiver<CodexAppServerEvent>,
    command: CodexCommand,
    cwd: PathBuf,
    machine: bool,
    active_turn: &std::sync::Mutex<Option<(String, String)>>,
) -> Result<(), CliExit> {
    match command {
        CodexCommand::Models => print_result(
            client
                .request("model/list", json!({}))
                .await
                .map_err(failure)?,
            machine,
        ),
        CodexCommand::Threads {
            cwd: filter,
            cursor,
        } => {
            let mut params = json!({ "limit": 50 });
            if filter.is_some() {
                params["cwd"] = json!(cwd);
            }
            if let Some(cursor) = cursor {
                params["cursor"] = json!(cursor);
            }
            print_result(
                client
                    .request("thread/list", params)
                    .await
                    .map_err(failure)?,
                machine,
            )
        }
        CodexCommand::Run(args) => {
            run_turn(client, events, &args, &cwd, machine, active_turn).await
        }
    }
}

fn print_result(value: Value, machine: bool) -> Result<(), CliExit> {
    let mut out = io::stdout().lock();
    if machine {
        serde_json::to_writer(&mut out, &value).map_err(failure)?;
    } else {
        serde_json::to_writer_pretty(&mut out, &value).map_err(failure)?;
    }
    writeln!(out).map_err(failure)
}

fn thread_request(args: &RunArgs, cwd: &std::path::Path) -> (&'static str, Value) {
    let mut params = json!({ "cwd": cwd, "sandbox": args.sandbox.wire(), "approvalPolicy": "on-request", "approvalsReviewer": "user" });
    if let Some(model) = &args.model {
        params["model"] = json!(model);
    }
    let method = if let Some(id) = &args.resume {
        params["threadId"] = json!(id);
        "thread/resume"
    } else if let Some(id) = &args.fork {
        params["threadId"] = json!(id);
        "thread/fork"
    } else {
        "thread/start"
    };
    (method, params)
}

async fn start_turn(
    client: &CodexAppServer,
    args: &RunArgs,
    cwd: &std::path::Path,
) -> Result<(String, String), CliExit> {
    let (method, params) = thread_request(args, cwd);
    let thread = client.request(method, params).await.map_err(failure)?;
    let id = thread
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| failure("Codex returned no thread identity"))?;
    let turn = client
        .request(
            "turn/start",
            json!({
                "threadId": id, "input": [{ "type": "text", "text": args.prompt }],
            }),
        )
        .await
        .map_err(failure)?;
    let turn_id = turn
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .ok_or_else(|| failure("Codex returned no turn identity"))?;
    Ok((id.to_owned(), turn_id.to_owned()))
}

async fn run_turn(
    client: &CodexAppServer,
    events: &mut mpsc::Receiver<CodexAppServerEvent>,
    args: &RunArgs,
    cwd: &std::path::Path,
    machine: bool,
    active_turn: &std::sync::Mutex<Option<(String, String)>>,
) -> Result<(), CliExit> {
    let (id, turn_id) = start_turn(client, args, cwd).await?;
    *active_turn.lock().expect("active Codex turn") = Some((id.clone(), turn_id.clone()));
    if machine {
        print_result(
            json!({"type":"started", "threadId":id,"turnId":turn_id}),
            true,
        )?;
    } else {
        eprintln!("Codex thread: {id}\nOpen: codex://threads/{id}");
    }
    let mut output = TurnOutput::new(&id, &turn_id, machine);
    let completed = tokio::select! {
        result = output.read(client, events) => result,
        _ = tokio::time::sleep(Duration::from_secs(args.timeout)) => {
            interrupt(client, &id, &turn_id).await;
            Err(failure("Codex turn timed out and was interrupted"))
        }
    };
    if !machine {
        eprintln!();
    }
    completed
}

async fn interrupt(client: &CodexAppServer, thread_id: &str, turn_id: &str) {
    let _ = tokio::time::timeout(
        Duration::from_secs(5),
        client.request(
            "turn/interrupt",
            json!({"threadId":thread_id,"turnId":turn_id}),
        ),
    )
    .await;
}

struct TurnOutput<'a> {
    thread_id: &'a str,
    turn_id: &'a str,
    machine: bool,
    denied: bool,
    streamed_items: std::collections::HashSet<String>,
    queued_requests: std::collections::VecDeque<CodexAppServerEvent>,
}

enum ApprovalOutcome {
    Answer(Option<Value>, bool),
    Completed(Result<(), CliExit>),
}

fn terminal_text(text: &str) -> String {
    text.chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect()
}

impl<'a> TurnOutput<'a> {
    fn new(thread_id: &'a str, turn_id: &'a str, machine: bool) -> Self {
        Self {
            thread_id,
            turn_id,
            machine,
            denied: false,
            streamed_items: Default::default(),
            queued_requests: Default::default(),
        }
    }

    async fn read(
        &mut self,
        client: &CodexAppServer,
        events: &mut mpsc::Receiver<CodexAppServerEvent>,
    ) -> Result<(), CliExit> {
        loop {
            let event = match self.queued_requests.pop_front() {
                Some(event) => event,
                None => match events.recv().await {
                    Some(event) => event,
                    None => break,
                },
            };
            match event {
                CodexAppServerEvent::Notification { method, params } => {
                    if let Some(result) = self.notification(&method, &params)? {
                        return result;
                    }
                }
                CodexAppServerEvent::ServerRequest { id, method, params } => {
                    if let Some(result) = self
                        .handle_request(client, events, id, &method, &params)
                        .await?
                    {
                        return result;
                    }
                }
                CodexAppServerEvent::ProtocolError { message } => return Err(failure(message)),
                CodexAppServerEvent::Exited { code } => {
                    return Err(failure(format!(
                        "Codex exited before turn completion ({code:?})"
                    )))
                }
            }
        }
        Err(failure("Codex disconnected before turn completion"))
    }

    async fn handle_request(
        &mut self,
        client: &CodexAppServer,
        events: &mut mpsc::Receiver<CodexAppServerEvent>,
        id: Value,
        method: &str,
        params: &Value,
    ) -> Result<Option<Result<(), CliExit>>, CliExit> {
        // Never answer an approval for another conversation with this turn's UI.
        if !self.matches(params) {
            client
                .respond_error(id, -32602, "Request belongs to another turn")
                .await
                .map_err(failure)?;
            return Ok(None);
        }
        let interactive = !self.machine && io::stdin().is_terminal();
        let response = interaction::respond(method, params, interactive);
        let (result, denied) = match self.wait_for_answer(&id, events, response).await? {
            ApprovalOutcome::Answer(result, denied) => (result, denied),
            ApprovalOutcome::Completed(result) => return Ok(Some(result)),
        };
        self.denied |= denied;
        if self.machine {
            print_result(
                json!({"type":"serverRequest","method":method,"params":params,"handled":false}),
                true,
            )?;
        }
        match result {
            Some(result) => client.respond(id, result).await.map_err(failure)?,
            None => client
                .respond_error(id, -32601, "Unsupported request in CC-Panes CLI")
                .await
                .map_err(failure)?,
        }
        Ok(None)
    }

    async fn wait_for_answer(
        &mut self,
        request_id: &Value,
        events: &mut mpsc::Receiver<CodexAppServerEvent>,
        response: impl std::future::Future<Output = (Option<Value>, bool)>,
    ) -> Result<ApprovalOutcome, CliExit> {
        tokio::pin!(response);
        loop {
            tokio::select! {
                // Drain already-arrived terminal/resolve events before accepting an answer.
                biased;
                event = events.recv() => match event {
                    Some(CodexAppServerEvent::Notification { method, params }) => {
                        if method == "serverRequest/resolved" && self.matches(&params) {
                            let resolved = &params["requestId"];
                            self.queued_requests.retain(|event| !matches!(event, CodexAppServerEvent::ServerRequest { id, .. } if id == resolved));
                            if resolved == request_id {
                                // Exit instead of leaving a cancelled stdin reader that
                                // could consume an answer intended for a later approval.
                                return Err(CliExit::conflict("Codex cleared the pending question; this CLI run was stopped. Resume the thread to continue."));
                            }
                        }
                        if let Some(result) = self.notification(&method, &params)? {
                            return Ok(ApprovalOutcome::Completed(result));
                        }
                    }
                    Some(event @ CodexAppServerEvent::ServerRequest { .. }) => {
                        if self.queued_requests.len() >= 128 { return Err(failure("Too many pending Codex questions")); }
                        self.queued_requests.push_back(event);
                    }
                    Some(CodexAppServerEvent::ProtocolError { message }) => return Err(failure(message)),
                    Some(CodexAppServerEvent::Exited { .. }) | None => return Err(failure("Codex disconnected while waiting for an answer")),
                },
                (result, denied) = &mut response => return Ok(ApprovalOutcome::Answer(result, denied)),
            }
        }
    }

    fn matches(&self, params: &Value) -> bool {
        params
            .get("threadId")
            .and_then(Value::as_str)
            .is_none_or(|id| id == self.thread_id)
            && params
                .get("turnId")
                .and_then(Value::as_str)
                .is_none_or(|id| id == self.turn_id)
    }

    fn notification(
        &mut self,
        method: &str,
        params: &Value,
    ) -> Result<Option<Result<(), CliExit>>, CliExit> {
        if !self.matches(params) {
            return Ok(None);
        }
        if self.machine {
            print_result(
                json!({"type":"notification","method":method,"params":params}),
                true,
            )?;
        } else {
            self.render(method, params)?;
        }
        if method != "turn/completed" {
            return Ok(None);
        }
        let turn = &params["turn"];
        if turn["id"].as_str() != Some(self.turn_id) {
            return Ok(None);
        }
        let status = turn["status"].as_str().unwrap_or("unknown");
        Ok(Some(match status {
            "completed" if !self.denied => Ok(()),
            "completed" => Err(CliExit::conflict(
                "Codex finished with requests declined; run interactively to answer approvals",
            )),
            "interrupted" => Err(CliExit::silent(130)),
            _ => Err(failure(
                turn.pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex turn failed"),
            )),
        }))
    }

    fn render(&mut self, method: &str, params: &Value) -> Result<(), CliExit> {
        let mut stdout = io::stdout().lock();
        match method {
            "item/agentMessage/delta" => {
                if let Some(id) = params["itemId"].as_str() {
                    self.streamed_items.insert(id.to_owned());
                }
                write!(
                    stdout,
                    "{}",
                    terminal_text(params["delta"].as_str().unwrap_or(""))
                )
                .map_err(failure)?;
                stdout.flush().map_err(failure)?;
            }
            "item/completed" if params["item"]["type"] == "agentMessage" => {
                let item = &params["item"];
                if !self
                    .streamed_items
                    .contains(item["id"].as_str().unwrap_or(""))
                {
                    writeln!(
                        stdout,
                        "{}",
                        terminal_text(item["text"].as_str().unwrap_or(""))
                    )
                    .map_err(failure)?;
                }
            }
            "error" => eprintln!(
                "Codex: {}",
                terminal_text(
                    params
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("turn error")
                )
            ),
            _ => {}
        }
        Ok(())
    }
}
