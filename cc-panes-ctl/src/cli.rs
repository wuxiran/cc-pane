use std::path::PathBuf;

use clap::{ArgGroup, Parser, Subcommand, ValueEnum};

use crate::commands::{self, CommandContext};
use crate::discovery::DataDirMode;

#[derive(Debug, Parser)]
#[command(name = "cc-panes-ctl", about = "CC-Panes control-plane CLI")]
pub struct Cli {
    #[arg(long, conflicts_with_all = ["release", "auto", "data_dir"])]
    dev: bool,
    #[arg(long, conflicts_with_all = ["dev", "auto", "data_dir"])]
    release: bool,
    #[arg(long, conflicts_with_all = ["dev", "release", "data_dir"])]
    auto: bool,
    #[arg(long, value_name = "PATH", conflicts_with_all = ["dev", "release", "auto"])]
    data_dir: Option<PathBuf>,
    /// Emit machine-readable output. Place before the subcommand.
    #[arg(long)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Report orchestrator and daemon lifecycle for the selected instance(s).
    Status,
    /// Inspect and control daemon-hosted terminal sessions.
    Sessions {
        #[command(subcommand)]
        command: SessionsCommand,
    },
    /// Inspect and update task bindings through MCP.
    Bindings {
        #[command(subcommand)]
        command: BindingsCommand,
    },
    /// Launch a registered project through the orchestrator.
    #[command(group(
        ArgGroup::new("launch_input")
            .required(true)
            .args(["prompt", "resume"])
    ))]
    Launch {
        project: String,
        #[arg(long, conflicts_with = "resume")]
        prompt: Option<String>,
        #[arg(long, value_name = "SESSION_ID", conflicts_with = "prompt")]
        resume: Option<String>,
        #[arg(long, value_name = "TOOL")]
        cli: Option<String>,
        #[arg(long, value_name = "local|wsl|ssh")]
        runtime: Option<String>,
        #[arg(long)]
        title: Option<String>,
    },
    /// List MCP tools discovered at runtime.
    Tools {
        #[arg(long, value_name = "NAME")]
        schema: Option<String>,
    },
    /// Call any MCP tool.
    Call {
        tool: String,
        #[arg(long = "json", value_name = "OBJECT", conflicts_with = "arg")]
        arguments_json: Option<String>,
        #[arg(long = "arg", value_name = "KEY=VALUE")]
        arg: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
enum SessionsCommand {
    List,
    Read {
        id: String,
        #[arg(long, default_value_t = 200)]
        lines: usize,
    },
    Submit {
        id: String,
        text: String,
    },
    Write {
        id: String,
        #[arg(long)]
        key: ControlKey,
    },
    Kill {
        id: String,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ControlKey {
    Esc,
    CtrlC,
    CtrlD,
    Cr,
}

impl ControlKey {
    fn bytes(self) -> &'static str {
        match self {
            Self::Esc => "\x1b",
            Self::CtrlC => "\x03",
            Self::CtrlD => "\x04",
            Self::Cr => "\r",
        }
    }
}

#[derive(Debug, Subcommand)]
enum BindingsCommand {
    List {
        #[arg(long)]
        stale: bool,
    },
    Close {
        id: String,
        #[arg(long, value_enum, default_value_t = BindingTerminalStatus::Completed)]
        status: BindingTerminalStatus,
        #[arg(long, default_value_t = 100)]
        progress: i32,
        #[arg(long)]
        summary: Option<String>,
        #[arg(long)]
        exit_code: Option<i32>,
        #[arg(long)]
        force_offline_db: bool,
    },
    Reconcile {
        #[arg(
            long,
            conflicts_with = "plan_path",
            required_unless_present = "plan_path"
        )]
        leader_id: Option<String>,
        #[arg(
            long,
            conflicts_with = "leader_id",
            required_unless_present = "leader_id"
        )]
        plan_path: Option<String>,
        #[arg(long)]
        verbose: bool,
        #[arg(long)]
        force_offline_db: bool,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum BindingTerminalStatus {
    Completed,
    Failed,
}

impl BindingTerminalStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliExit {
    pub code: i32,
    pub message: String,
}

impl CliExit {
    pub(crate) fn source(message: impl Into<String>) -> Self {
        Self {
            code: 2,
            message: message.into(),
        }
    }

    pub(crate) fn argument(message: impl Into<String>) -> Self {
        Self {
            code: 3,
            message: message.into(),
        }
    }

    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self {
            code: 4,
            message: message.into(),
        }
    }
}

pub fn execute(cli: Cli) -> Result<(), CliExit> {
    let context = CommandContext {
        mode: data_mode(&cli),
        json: cli.json,
        launch_id: std::env::var("CC_PANES_LAUNCH_ID").ok(),
    };
    match cli.command {
        Command::Status => commands::status(&context),
        Command::Sessions { command } => match command {
            SessionsCommand::List => commands::sessions_list(&context),
            SessionsCommand::Read { id, lines } => commands::sessions_read(&context, &id, lines),
            SessionsCommand::Submit { id, text } => commands::sessions_submit(&context, &id, &text),
            SessionsCommand::Write { id, key } => {
                commands::sessions_write(&context, &id, key.bytes())
            }
            SessionsCommand::Kill { id } => commands::sessions_kill(&context, &id),
        },
        Command::Bindings { command } => match command {
            BindingsCommand::List { stale } => commands::bindings_list(&context, stale),
            BindingsCommand::Close {
                id,
                status,
                progress,
                summary,
                exit_code,
                force_offline_db,
            } => commands::bindings_close(
                &context,
                &id,
                status.as_str(),
                progress,
                summary,
                exit_code,
                force_offline_db,
            ),
            BindingsCommand::Reconcile {
                leader_id,
                plan_path,
                verbose,
                force_offline_db,
            } => commands::bindings_reconcile(
                &context,
                leader_id.as_deref(),
                plan_path.as_deref(),
                verbose,
                force_offline_db,
            ),
        },
        Command::Launch {
            project,
            prompt,
            resume,
            cli,
            runtime,
            title,
        } => commands::launch(&context, &project, prompt, resume, cli, runtime, title),
        Command::Tools { schema } => commands::tools(&context, schema.as_deref()),
        Command::Call {
            tool,
            arguments_json,
            arg,
        } => commands::call(&context, &tool, arguments_json.as_deref(), &arg),
    }
}

fn data_mode(cli: &Cli) -> DataDirMode {
    if let Some(path) = cli.data_dir.as_ref() {
        DataDirMode::Custom(path.clone())
    } else if cli.dev {
        DataDirMode::Dev
    } else if cli.release {
        DataDirMode::Release
    } else {
        DataDirMode::Auto
    }
}

#[cfg(test)]
mod tests {
    use super::ControlKey;

    #[test]
    fn control_keys_are_real_terminal_bytes() {
        assert_eq!(ControlKey::Esc.bytes().as_bytes(), &[0x1b]);
        assert_eq!(ControlKey::CtrlC.bytes().as_bytes(), &[0x03]);
        assert_eq!(ControlKey::CtrlD.bytes().as_bytes(), &[0x04]);
        assert_eq!(ControlKey::Cr.bytes().as_bytes(), &[0x0d]);
    }
}
