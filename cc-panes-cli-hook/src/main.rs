mod common;
mod events;
mod notify;
mod plan_archive;
mod session_start;

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
