//! Query-time detection of CLI approval dialogs (issue #64-#4).
//!
//! Codex has no hook for its approval overlays ("Allow the ccpanes MCP server to
//! run tool ...?", "Would you like to run the following command?"), and PTY chunk
//! inference only sees partial redraws, so a worker blocked on such a dialog used
//! to report `active` / `idle` for as long as nobody pressed a key. The plain
//! output buffer is a rendered screen (cursor moves overwrite cells), so reading
//! its bottom rows tells whether the dialog is *currently* displayed.
//!
//! Both a question line and an option/footer line must be visible: a model
//! merely writing "Do you want to proceed?" in its answer is not an approval
//! dialog, and misreporting `idle` as `waitingInput` would stall leaders.

use cc_panes_core::services::terminal_service::SessionStatus;

/// Rendered rows inspected from the bottom of the screen.
pub(crate) const APPROVAL_SCAN_LINES: usize = 40;
const MAX_PROMPT_CHARS: usize = 200;

const QUESTION_MARKERS: &[&str] = &[
    // Codex approval overlays.
    "mcp server to run tool",
    "would you like to run the following command",
    "would you like to make the following edits",
    "do you want to approve network access",
    // Claude Code permission dialogs (normally reported by the Notification hook;
    // kept as a fallback when hooks are missing).
    "do you want to proceed?",
    "do you want to make this edit",
    "do you want to create ",
    "do you want to allow",
];

const CHOICE_MARKERS: &[&str] = &["1. yes", "press enter to confirm", "esc to cancel", "(y/n)"];

fn strip_frame(line: &str) -> &str {
    line.trim_matches(|c: char| {
        c.is_whitespace() || matches!(c, '│' | '┃' | '║' | '|' | '╭' | '╰' | '╮' | '╯' | '─')
    })
}

/// Returns the visible approval question, if the bottom of the rendered screen
/// currently shows an approval dialog.
pub(crate) fn detect_pending_approval(lines: &[String]) -> Option<String> {
    let start = lines.len().saturating_sub(APPROVAL_SCAN_LINES);
    let window = &lines[start..];
    let lowered: Vec<String> = window.iter().map(|line| line.to_lowercase()).collect();
    let question = lowered
        .iter()
        .rposition(|line| QUESTION_MARKERS.iter().any(|marker| line.contains(marker)))?;
    // Options are rendered below the question; anything above it is stale text.
    let has_choice = lowered[question..]
        .iter()
        .any(|line| CHOICE_MARKERS.iter().any(|marker| line.contains(marker)));
    if !has_choice {
        return None;
    }
    let prompt: String = strip_frame(&window[question])
        .chars()
        .take(MAX_PROMPT_CHARS)
        .collect();
    Some(prompt)
}

/// Only live, non-blocked states can be hiding a dialog. `waitingInput` is already
/// correct; `exited` / `error` must never be upgraded.
pub(super) fn status_may_hide_approval(status: SessionStatus) -> bool {
    !matches!(
        status,
        SessionStatus::WaitingInput | SessionStatus::Exited | SessionStatus::Error
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_string).collect()
    }

    #[test]
    fn codex_mcp_tool_approval_is_detected_with_tool_name() {
        let screen = lines(
            "• Done. Reporting back.\n\
             \n\
             Allow the ccpanes MCP server to run tool \"update_task_binding\"?\n\
             \n\
             › 1. Yes, provide the requested info\n\
               2. No, but continue without it\n\
             \n\
             Press enter to confirm or esc to cancel",
        );
        assert_eq!(
            detect_pending_approval(&screen).as_deref(),
            Some("Allow the ccpanes MCP server to run tool \"update_task_binding\"?")
        );
    }

    #[test]
    fn codex_command_approval_inside_frame_is_detected() {
        let screen = lines(
            "│ Would you like to run the following command? │\n\
             │ $ rm -rf build                               │\n\
             │ › 1. Yes, proceed (y)                         │",
        );
        assert_eq!(
            detect_pending_approval(&screen).as_deref(),
            Some("Would you like to run the following command?")
        );
    }

    #[test]
    fn model_question_without_dialog_options_is_not_an_approval() {
        let screen = lines("I refactored the parser.\nDo you want to proceed?\n\n› ");
        assert_eq!(detect_pending_approval(&screen), None);
    }

    #[test]
    fn stale_dialog_scrolled_above_scan_window_is_ignored() {
        let mut screen =
            lines("Would you like to run the following command?\n› 1. Yes, proceed (y)");
        screen.extend((0..APPROVAL_SCAN_LINES).map(|i| format!("output {i}")));
        assert_eq!(detect_pending_approval(&screen), None);
    }

    #[test]
    fn options_above_the_question_do_not_count() {
        let screen = lines("1. Yes, earlier menu\nWould you like to run the following command?");
        assert_eq!(detect_pending_approval(&screen), None);
    }

    #[test]
    fn only_live_statuses_are_probed() {
        assert!(status_may_hide_approval(SessionStatus::Active));
        assert!(status_may_hide_approval(SessionStatus::Idle));
        assert!(status_may_hide_approval(SessionStatus::ToolRunning));
        assert!(!status_may_hide_approval(SessionStatus::WaitingInput));
        assert!(!status_may_hide_approval(SessionStatus::Exited));
        assert!(!status_may_hide_approval(SessionStatus::Error));
    }
}
