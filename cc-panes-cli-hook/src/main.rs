mod common;
mod events;
mod notify;
mod permission_request;
mod plan_archive;
mod session_start;

#[cfg(test)]
mod permission_request_tests;

use clap::{Parser, Subcommand};
use std::io::Read;

#[derive(Parser)]
#[command(
    name = "cc-panes-cli-hook",
    about = "Shared CLI hook runner for CC-Panes"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    // ============ 原有子命令（保留兼容） ============
    /// SessionStart hook - inject project and workspace context（保留：当前 adapter 写入此名）
    SessionStart,
    /// PostToolUse hook - archive plan files（保留：当前 adapter 写入此名）
    PlanArchive,
    /// Explicitly trigger a CC-Panes notification via the local orchestrator API
    Notify(notify::NotifyArgs),
    /// Claude PermissionRequest hook - ask the local queue orchestrator for a decision
    PermissionRequest,

    // ============ cc-pane 抽象事件子命令（阶段 1：alias，阶段 2 落地业务逻辑） ============
    //
    // 子命令按 cc-pane 事件命名（与 Claude/Codex 原生事件名解耦）。
    // 阶段 1 暂时 alias 到现有实现：
    //   - session-init / session-resume → session_start::run（内部按 stdin.source 自分发，行为不变）
    //   - tool-after                    → plan_archive::run（行为不变）
    //   - 其余子命令暂返回未实现错误（阶段 2 接入 SessionStateMachine 时填充）
    /// cc-pane SessionInit hook（alias → SessionStart，业务逻辑阶段 2 接入）
    SessionInit,
    /// cc-pane SessionResume hook（alias → SessionStart，业务逻辑阶段 2 接入）
    SessionResume,
    /// cc-pane SessionEnd hook（阶段 2 实现）
    SessionEnd,
    /// cc-pane PromptBefore hook（阶段 2 实现）
    PromptBefore,
    /// cc-pane ToolBefore hook（阶段 2 实现）
    ToolBefore,
    /// cc-pane ToolAfter hook（alias → PlanArchive，业务逻辑阶段 2 接入）
    ToolAfter,
    /// cc-pane TurnEnd hook（阶段 2 实现）
    TurnEnd,
    /// cc-pane BeforeCompact hook（阶段 2 实现）
    BeforeCompact,
    /// cc-pane WaitingInput hook（阶段 2 实现）
    WaitingInput,
    /// cc-pane Error hook（阶段 2 实现）
    Error,
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        // 原有子命令（adapter 当前仍写这些名字）
        Commands::SessionStart => session_start::run(),
        Commands::PlanArchive => plan_archive::run(),
        Commands::Notify(args) => notify::run(args),
        Commands::PermissionRequest => permission_request::run(),

        // cc-pane 事件子命令：先一次性读 stdin → 上报状态机 → 调旧业务逻辑（如需）
        Commands::SessionInit => dispatch_with_business("session-init", DispatchKind::SessionStart),
        Commands::SessionResume => {
            dispatch_with_business("session-resume", DispatchKind::SessionStart)
        }
        Commands::ToolAfter => dispatch_with_business("tool-after", DispatchKind::PlanArchive),
        Commands::SessionEnd => dispatch_with_business("session-end", DispatchKind::None),
        Commands::PromptBefore => dispatch_with_business("prompt-before", DispatchKind::None),
        Commands::ToolBefore => dispatch_with_business("tool-before", DispatchKind::None),
        Commands::TurnEnd => dispatch_with_business("turn-end", DispatchKind::None),
        Commands::BeforeCompact => dispatch_with_business("before-compact", DispatchKind::None),
        Commands::WaitingInput => dispatch_with_business("waiting-input", DispatchKind::None),
        Commands::Error => dispatch_with_business("error", DispatchKind::None),
    }
}

/// cc-pane 事件子命令上报后要不要继续调旧业务逻辑。
enum DispatchKind {
    /// 不调旧逻辑（纯状态机上报）
    None,
    /// 上报后调 session_start::run_with_stdin（context 注入）
    SessionStart,
    /// 上报后调 plan_archive::run_with_stdin（plan 归档）
    PlanArchive,
}

/// cc-pane 事件子命令的统一入口：
/// stdin 只能读一次 → 读到 String → 既上报状态机又转发给旧业务。
fn dispatch_with_business(event_name: &str, kind: DispatchKind) {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);

    if !should_dispatch_event(event_name, &raw) {
        return;
    }

    events::dispatch::report_with_payload(event_name, &raw);

    // OSC in-band 通道：仅纯状态子命令与 stdout 无输出的业务子命令可发
    // （terminalSequence JSON 必须独占 stdout；session-init/resume 的
    //  context 注入是纯文本 stdout，不能混）。
    match kind {
        DispatchKind::None | DispatchKind::PlanArchive => {
            events::dispatch::emit_terminal_sequence(event_name);
        }
        DispatchKind::SessionStart => {}
    }

    match kind {
        DispatchKind::None => {}
        DispatchKind::SessionStart => session_start::run_with_stdin(&raw),
        DispatchKind::PlanArchive => plan_archive::run_with_stdin(&raw),
    }
}

fn should_dispatch_event(event_name: &str, raw_stdin: &str) -> bool {
    match event_name {
        "session-end" => {
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(raw_stdin) else {
                return true;
            };
            !matches!(
                payload.get("reason").and_then(serde_json::Value::as_str),
                Some("clear" | "prompt_input_exit")
            )
        }
        "waiting-input" => should_dispatch_waiting_input(raw_stdin),
        _ => true,
    }
}

/// Notification → waiting-input 的例行噪声过滤（对齐 Orca 的丢弃规则）。
///
/// 三类不上报：
/// - grok 每个工具前都发的「Tool permission requested」（bypass 模式也发，
///   进度已由 tool-before/after 覆盖）——grok 经 Claude 兼容层执行同一份
///   hooks，这条不滤会把「正在跑工具」弹成「需要你输入」；
/// - `idle_prompt` 类型（旧 matcher 装出去的存量条目）：输入框闲置 60s 是
///   「人走开了」不是「agent 卡住了」；
/// - TUI composer 空闲文案（type your message 等）。
fn should_dispatch_waiting_input(raw_stdin: &str) -> bool {
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(raw_stdin) else {
        return true;
    };
    let notification_type = payload
        .get("notificationType")
        .or_else(|| payload.get("notification_type"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if notification_type == "idle_prompt" {
        return false;
    }
    let message = payload
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if message == "tool permission requested" {
        return false;
    }
    const IDLE_COMPOSER_MARKERS: &[&str] = &["type your message", "ask a side question"];
    if IDLE_COMPOSER_MARKERS.iter().any(|m| message.contains(m)) {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_end_clear_and_prompt_input_exit_skip_both_report_channels() {
        assert!(!should_dispatch_event(
            "session-end",
            r#"{"reason":"clear"}"#
        ));
        assert!(!should_dispatch_event(
            "session-end",
            r#"{"reason":"prompt_input_exit"}"#,
        ));
    }

    #[test]
    fn session_end_logout_missing_reason_and_invalid_json_remain_fail_open() {
        assert!(should_dispatch_event(
            "session-end",
            r#"{"reason":"logout"}"#,
        ));
        assert!(should_dispatch_event(
            "session-end",
            r#"{"reason":"other"}"#,
        ));
        assert!(should_dispatch_event(
            "session-end",
            r#"{"session_id":"s1"}"#
        ));
        assert!(should_dispatch_event("session-end", "not-json"));
    }

    #[test]
    fn reason_filter_does_not_affect_other_events() {
        assert!(should_dispatch_event("turn-end", r#"{"reason":"clear"}"#,));
    }

    // waiting-input 噪声过滤：例行/闲置类通知不得上报（grok 误报根因，2026-08）。
    #[test]
    fn waiting_input_drops_grok_routine_tool_permission_notice() {
        assert!(!should_dispatch_event(
            "waiting-input",
            r#"{"message":"Tool permission requested"}"#,
        ));
        assert!(!should_dispatch_event(
            "waiting-input",
            r#"{"message":"  tool permission requested  "}"#,
        ));
    }

    #[test]
    fn waiting_input_drops_idle_prompt_and_composer_texts() {
        assert!(!should_dispatch_event(
            "waiting-input",
            r#"{"notificationType":"idle_prompt","message":"Claude is waiting for your input"}"#,
        ));
        assert!(!should_dispatch_event(
            "waiting-input",
            r#"{"notification_type":"idle_prompt","message":"whatever"}"#,
        ));
        assert!(!should_dispatch_event(
            "waiting-input",
            r#"{"message":"Type your message or ask a side question"}"#,
        ));
    }

    #[test]
    fn waiting_input_real_permission_requests_remain_fail_open() {
        assert!(should_dispatch_event(
            "waiting-input",
            r#"{"notificationType":"permission_prompt","message":"Claude needs your permission to use Bash"}"#,
        ));
        assert!(should_dispatch_event("waiting-input", "not-json"));
        assert!(should_dispatch_event("waiting-input", r#"{}"#));
    }
}
