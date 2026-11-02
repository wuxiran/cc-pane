use std::io::Read;
use std::path::PathBuf;

use cc_panes_core::services::codex_desktop::{codex_chat_url, MAX_DESKTOP_PROMPT_BYTES};
use clap::{ArgGroup, Args};
use serde_json::json;

use super::{failure, print_result};
use crate::cli::CliExit;

#[derive(Debug, Args)]
#[command(group(ArgGroup::new("handoff_prompt").required(true).args(["prompt", "prompt_file"])))]
pub struct HandoffArgs {
    /// Task text to prefill. This is not automatically submitted.
    #[arg(long, conflicts_with = "prompt_file")]
    pub prompt: Option<String>,
    /// UTF-8 task file. Read without shell interpolation (maximum 8 KiB).
    #[arg(long, conflicts_with = "prompt", value_name = "FILE")]
    pub prompt_file: Option<PathBuf>,
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// Prepare and print the URL without opening any application.
    #[arg(long)]
    pub dry_run: bool,
}

fn load_prompt(args: &HandoffArgs) -> Result<String, CliExit> {
    let text = if let Some(text) = &args.prompt {
        text.clone()
    } else {
        let path = args
            .prompt_file
            .as_ref()
            .ok_or_else(|| CliExit::argument("A task prompt is required"))?;
        if !std::fs::metadata(path).map_err(failure)?.is_file() {
            return Err(CliExit::argument(
                "The prompt file must be a regular UTF-8 file",
            ));
        }
        let file = std::fs::File::open(path).map_err(failure)?;
        if !file.metadata().map_err(failure)?.is_file() {
            return Err(CliExit::argument(
                "The prompt file must be a regular UTF-8 file",
            ));
        }
        let mut text = String::new();
        file.take(MAX_DESKTOP_PROMPT_BYTES as u64 + 1)
            .read_to_string(&mut text)
            .map_err(failure)?;
        text
    };
    if text.trim().is_empty() || text.len() > MAX_DESKTOP_PROMPT_BYTES {
        return Err(CliExit::argument("The desktop task must contain 1–8192 UTF-8 bytes; reference a local plan file for longer tasks"));
    }
    Ok(text)
}

pub(super) async fn execute(args: HandoffArgs, machine: bool) -> Result<(), CliExit> {
    let text = load_prompt(&args)?;
    let cwd = super::workspace(args.cwd)?;
    let cwd = cwd
        .to_str()
        .ok_or_else(|| CliExit::argument("The workspace path must be UTF-8"))?;
    let url = codex_chat_url(cwd, None, Some(&text)).map_err(failure)?;
    if !args.dry_run {
        open_desktop(&url).await?;
    }
    let status = if args.dry_run {
        "draft_prepared"
    } else {
        "awaiting_user_send"
    };
    if machine {
        print_result(
            json!({
                "target":"codex-desktop", "status":status,
                "openRequested":!args.dry_run, "submitted":false, "cwd":cwd, "url":url,
            }),
            true,
        )
    } else {
        eprintln!(
            "{}",
            if args.dry_run {
                "Codex desktop draft prepared; no app was opened."
            } else {
                "Requested Codex Mac to open the draft. Click Send there to start; no task has been submitted by this command."
            }
        );
        println!("{url}");
        Ok(())
    }
}

#[cfg(target_os = "macos")]
async fn open_desktop(url: &str) -> Result<(), CliExit> {
    let mut child = tokio::process::Command::new("/usr/bin/open")
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(failure)?;
    match tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(_) => Err(failure(
            "Could not open Codex Mac; check that the desktop app is installed",
        )),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(failure(
                "Opening Codex Mac timed out; do not assume the draft was delivered",
            ))
        }
    }
}

#[cfg(not(target_os = "macos"))]
async fn open_desktop(_url: &str) -> Result<(), CliExit> {
    Err(CliExit::argument(
        "Desktop handoff currently requires macOS; --dry-run can prepare a link without opening it",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn handoff_requires_exactly_one_prompt_source() {
        for args in [
            vec!["ctl", "codex", "handoff"],
            vec![
                "ctl",
                "codex",
                "handoff",
                "--prompt",
                "x",
                "--prompt-file",
                "file",
            ],
        ] {
            assert!(crate::cli::Cli::try_parse_from(args).is_err());
        }
        assert!(crate::cli::Cli::try_parse_from([
            "ctl",
            "--json",
            "codex",
            "handoff",
            "--prompt-file",
            "task.txt",
            "--dry-run"
        ])
        .is_ok());
    }

    #[test]
    fn task_files_preserve_multiline_shell_characters_and_reject_empty_or_oversized_input() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("任务.txt");
        let text = "Review `literal` and $(do-not-run)\n保留 # & % ?";
        std::fs::write(&path, text).unwrap();
        let mut args = HandoffArgs {
            prompt: None,
            prompt_file: Some(path.clone()),
            cwd: dir.path().into(),
            dry_run: true,
        };
        assert_eq!(load_prompt(&args).unwrap(), text);
        std::fs::write(&path, vec![b'x'; MAX_DESKTOP_PROMPT_BYTES + 1]).unwrap();
        assert!(load_prompt(&args).is_err());
        args.prompt_file = None;
        args.prompt = Some(" \n\t".into());
        assert!(load_prompt(&args).is_err());
    }
}
