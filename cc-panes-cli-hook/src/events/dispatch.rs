//! cc-pane 事件子命令的统一上报入口。
//!
//! 每个 cc-pane 事件子命令调用 `report(event_name)` 或 `report_with_payload(...)` 完成：
//!   1. 读 stdin（hook 原始 payload，JSON 或空）
//!   2. 读 env（pty_session_id / task_binding_id / api endpoint）
//!   3. POST /api/hook-event 上报给 SessionStateMachine
//!   4. stderr 日志
//!
//! ## stdin 协议
//! stdin 只能读一次。对于需要在上报后再调用旧业务逻辑（session_start::run /
//! plan_archive::run）的子命令，**先读一次 stdin 缓存到 String**，把字符串既送给
//! dispatch（解析为 JSON 上报）又通过 `inject_stdin(&str)` 模拟出新的 stdin 给旧逻辑。
//! 这层桥接由调用方在 main.rs 显式编排。
//!
//! 设计原则：
//!   - 失败容忍：任何步骤失败都不阻断 hook（CLI 必须继续跑）
//!   - 低延迟：HTTP timeout 750ms，超时即放弃（状态机通过 PTY 兜底）
//!   - stdout 纪律：纯状态子命令输出 terminalSequence JSON（见下），
//!     业务子命令（session-init/resume 的 context 注入）保持纯文本 stdout，
//!     二者不混用
//!
//! ## 双通道上报
//! 同一事件走两条通道，后端 SessionStateMachine 跨通道去重：
//!   - HTTP POST（本文件）：带完整 payload，本地运行时的主通道
//!   - OSC in-band（`emit_terminal_sequence`）：stdout JSON 的 `terminalSequence`
//!     字段（Claude Code v2.1.141+，async hook 同样生效）让 Claude Code 本体把
//!     `OSC 777;notify;CCPanes;<agent>;<event>` 写入终端，随 PTY 字节流到达后端。
//!     WSL/SSH 运行时 HTTP 到不了后端，这是状态机唯一的信号来源。

use serde_json::json;

use crate::common::{
    env::optional_env,
    http::{post_json, ApiEndpoint},
    stdin::read_raw_stdin,
};

/// 读 stdin 并上报。仅供"上报后无需再走旧业务"的子命令使用。
#[allow(dead_code)]
pub fn report(event_name: &str) -> Option<String> {
    let raw = read_raw_stdin().unwrap_or_default();
    report_with_payload(event_name, &raw);
    Some(raw)
}

/// 把状态标记经 terminalSequence 写入终端（OSC in-band 通道）。
///
/// 前置条件（不满足则静默跳过）：
/// - `CC_PANES_PTY_SESSION_ID` 存在 —— 证明运行在 CC-Panes 受管终端里，
///   避免污染用户其他终端的 hook stdout 协议
/// - CLI 是 claude —— terminalSequence 是 Claude Code 的机制，
///   Codex/Gemini 的 hook stdout 语义不同
///
/// 调用方保证该子命令的 stdout 没有其他输出（JSON 必须独占 stdout）。
pub fn emit_terminal_sequence(event_name: &str) {
    if optional_env("CC_PANES_PTY_SESSION_ID").is_none() {
        return;
    }
    let agent = optional_env("CC_PANES_CLI_TOOL").unwrap_or_else(|| "claude".to_string());
    if agent != "claude" {
        return;
    }
    let seq = format!("\x1b]777;notify;CCPanes;{agent};{event_name}\x1b\\");
    println!("{}", json!({ "terminalSequence": seq }));
}

/// 在已读到 stdin 原文的情况下上报。失败不抛错，只打日志。
pub fn report_with_payload(event_name: &str, raw_stdin: &str) {
    let payload: serde_json::Value =
        serde_json::from_str(raw_stdin).unwrap_or(serde_json::Value::Null);

    let pty_session_id = match optional_env("CC_PANES_PTY_SESSION_ID") {
        Some(v) => v,
        None => {
            eprintln!(
                "[cc-panes-cli-hook] {}: CC_PANES_PTY_SESSION_ID missing, skip state machine report",
                event_name
            );
            return;
        }
    };

    let endpoint = match ApiEndpoint::from_env() {
        Ok(e) => e,
        Err(err) => {
            eprintln!(
                "[cc-panes-cli-hook] {}: api endpoint unavailable: {}",
                event_name, err
            );
            return;
        }
    };

    let body = json!({
        "ccPaneEvent": event_name,
        "ptySessionId": pty_session_id,
        "taskBindingId": optional_env("CC_PANES_TASK_BINDING_ID"),
        "payload": payload,
    });

    match post_json(&endpoint, "/api/hook-event", &body) {
        Ok(_) => {
            eprintln!(
                "[cc-panes-cli-hook] {}: reported to state machine (session={})",
                event_name, pty_session_id
            );
        }
        Err(err) => {
            eprintln!(
                "[cc-panes-cli-hook] {}: report failed (non-fatal): {}",
                event_name, err
            );
        }
    }
}
