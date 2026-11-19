//! Session identity arguments shared by local and WSL launches.
use anyhow::{ensure, Result};
use serde_json::Value;
use std::collections::HashMap;

/// CLIs whose adapters translate `forkSessionId` into a native fork launch.
/// Keep in sync with the `push_*_session_args` helpers below.
pub fn supports_session_fork(cli_tool_id: &str) -> bool {
    matches!(cli_tool_id, "claude" | "codex")
}

/// A fork source must be a plain session ID: never empty, never an option, never multi-line.
pub fn is_valid_fork_session_id(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('-') && !id.chars().any(char::is_control)
}

pub fn fork_source<'a>(
    options: &'a HashMap<String, Value>,
    resume: Option<&str>,
) -> Result<Option<&'a str>> {
    // Once the child ID has been captured, restarting must resume that child.
    if resume.is_some() {
        return Ok(None);
    }
    let Some(value) = options.get("forkSessionId") else {
        return Ok(None);
    };
    let id = value.as_str().unwrap_or_default().trim();
    ensure!(is_valid_fork_session_id(id), "Invalid fork session ID");
    Ok(Some(id))
}

pub fn push_claude_session_args(
    args: &mut Vec<String>,
    options: &HashMap<String, Value>,
    resume: Option<&str>,
    issued: Option<&str>,
) -> Result<()> {
    if let Some(id) = fork_source(options, resume)? {
        args.extend(["--resume".into(), id.into(), "--fork-session".into()]);
        if let Some(id) = issued {
            args.extend(["--session-id".into(), id.into()]);
        }
    } else if let Some(id) = resume {
        args.extend(["--resume".into(), id.into()]);
    } else if let Some(id) = issued {
        args.extend(["--session-id".into(), id.into()]);
    }
    Ok(())
}

pub fn push_codex_session_args(
    args: &mut Vec<String>,
    options: &HashMap<String, Value>,
    resume: Option<&str>,
) -> Result<()> {
    if let Some(id) = fork_source(options, resume)? {
        args.extend(["fork".into(), id.into()]);
    } else if let Some(id) = resume {
        args.extend(["resume".into(), id.into()]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options() -> HashMap<String, Value> {
        HashMap::from([("forkSessionId".into(), Value::String("source-id".into()))])
    }
    #[test]
    fn fork_has_independent_identity_and_restart_resumes_child() {
        let mut args = vec![];
        push_claude_session_args(&mut args, &options(), None, Some("child-id")).unwrap();
        assert_eq!(
            args,
            [
                "--resume",
                "source-id",
                "--fork-session",
                "--session-id",
                "child-id"
            ]
        );
        args.clear();
        push_codex_session_args(&mut args, &options(), None).unwrap();
        assert_eq!(args, ["fork", "source-id"]);
        args.clear();
        push_codex_session_args(&mut args, &options(), Some("child-id")).unwrap();
        assert_eq!(args, ["resume", "child-id"]);
        args.clear();
        push_claude_session_args(&mut args, &options(), Some("child-id"), None).unwrap();
        assert_eq!(args, ["--resume", "child-id"]);
    }
    #[test]
    fn only_adapters_with_a_native_fork_launch_report_support() {
        assert!(supports_session_fork("claude"));
        assert!(supports_session_fork("codex"));
        for other in ["grok", "gemini", "opencode", "cursor", "none", ""] {
            assert!(!supports_session_fork(other), "{other}");
        }
    }
    #[test]
    fn fork_ids_must_be_plain_session_ids() {
        assert!(is_valid_fork_session_id(
            "0199a1b2-aaaa-bbbb-cccc-000000000000"
        ));
        for bad in ["", "--last", "-r", "a\nb", "a\u{7}"] {
            assert!(!is_valid_fork_session_id(bad), "{bad:?}");
        }
    }
    #[test]
    fn invalid_fork_never_silently_starts_an_empty_session() {
        for value in [
            Value::Null,
            Value::Bool(true),
            Value::String("--last".into()),
            Value::String("\n".into()),
        ] {
            assert!(push_codex_session_args(
                &mut vec![],
                &HashMap::from([("forkSessionId".into(), value)]),
                None
            )
            .is_err());
        }
    }
}
