//! 跨 daemon 边界事件契约表（docs/78 §3）。
//!
//! # 为什么需要这张表
//!
//! daemon 架构本身从未出过问题，出问题的全是**边界**：resume id 掉进
//! `ws_emitter.rs` 的 `_ => {}`（docs/45，导致 `launch_history.resume_session_id`
//! 全 null、恢复出来的会话没有历史对话）、scrollback 停产、notifier 事件整族
//! 静默丢失。同一种病：**跨进程要传哪些事件从未被当成契约枚举过**，漏一个补
//! 一个，且死得无声——功能还在、就是没数据。
//!
//! 这张表把「哪些事件必须跨界、走哪条通道、丢了会怎样」写成数据，配合
//! `ws_emitter` 侧的穷举守卫测试，让 `_ => {}` 吞掉新事件在 CI 就报错。
//!
//! # 新增跨界事件的流程
//!
//! 1. 在 [`BOUNDARY_EVENTS`] 加一行；
//! 2. daemon emitter 加非默认分支（不加则守卫测试挂）；
//! 3. app 侧加 handler（`DaemonStreamMessage` / `DaemonControlMessage` /
//!    TS 的 `daemonEventContract.ts`，三处键集必须与本表一致）。

/// 事件走哪条跨界通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoundaryChannel {
    /// per-session WebSocket（`/ws/{id}`）。高频、有界队列、可丢。
    SessionWs,
    /// 控制通道（`/ws/control`）。低频、身份与生命周期事件走这里。
    Control,
    /// 先试 per-session WS，投不进（订阅者已断）再走 control 兜底。
    SessionWsWithControlFallback,
}

/// 事件丢失时的后果与补救方式。决定了它能不能走可丢队列。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LossSemantics {
    /// 可丢：队列满时整段丢弃并置 desync，前端走快照重放补回。
    /// **丢弃只能整段**——绝不能掐断 VT 序列中段（docs/71 不变式）。
    DroppableWithDesync,
    /// 必达：丢了没有任何补救路径，必须有兜底通道。
    MustDeliver,
    /// 可丢但留存：daemon 侧留副本，客户端重连时补拉。
    RetainedForReplay,
}

/// 事件从哪里进入跨界通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventOrigin {
    /// 经 `EventEmitter::emit` 进来——**这类必须在 emit 里有非默认分支**，
    /// 否则落进 `_ => {}` 静默丢失（docs/45 事故形态）。
    Emit,
    /// emitter 自己生成的出站信号，不经 emit（如队列溢出时插入的 desync）。
    EmitterGenerated,
    /// 独立入口（如 ControlSessionNotifier 的 publish_notifier_event）。
    DedicatedApi,
}

/// 一条跨界事件的契约。
#[derive(Debug, Clone, Copy)]
pub struct BoundaryEvent {
    /// 事件名（与 `constants::events` 或 control 消息 tag 一致）。
    pub name: &'static str,
    pub origin: EventOrigin,
    pub channel: BoundaryChannel,
    pub loss: LossSemantics,
    /// 旧版 app 收到本事件时的行为。新增事件必须能被旧 app 静默忽略。
    pub legacy_app_behavior: &'static str,
    /// 为什么是这个语义——写给后来者，避免"看着能改"就改。
    pub rationale: &'static str,
}

/// 全部跨界事件。**新增跨界事件必须先在这里加一行。**
pub const BOUNDARY_EVENTS: &[BoundaryEvent] = &[
    BoundaryEvent {
        name: crate::constants::events::TERMINAL_OUTPUT,
        origin: EventOrigin::Emit,
        channel: BoundaryChannel::SessionWs,
        loss: LossSemantics::DroppableWithDesync,
        legacy_app_behavior: "已有 handler（最早的跨界事件）",
        rationale: "唯一的高频事件。有界队列 256，溢出整段跳过并发 desync，\
                    前端走 resyncFromReplaySnapshot 重建——绝不掐 VT 中段。",
    },
    BoundaryEvent {
        name: crate::constants::events::TERMINAL_EXIT,
        origin: EventOrigin::Emit,
        channel: BoundaryChannel::SessionWsWithControlFallback,
        loss: LossSemantics::MustDeliver,
        legacy_app_behavior: "已有 handler",
        rationale: "丢了会让前端永远显示「运行中」的死会话。订阅者可能刚断开，\
                    所以投不进 per-session WS 时走 control 兜底。",
    },
    BoundaryEvent {
        name: crate::constants::events::SESSION_KILLED,
        origin: EventOrigin::Emit,
        channel: BoundaryChannel::SessionWsWithControlFallback,
        loss: LossSemantics::MustDeliver,
        legacy_app_behavior: "已有 handler",
        rationale: "同 exit：丢了标签关不掉。注意 app 侧按 KillReason 分流——\
                    回收类保留标签，其余关标签。",
    },
    BoundaryEvent {
        name: crate::constants::events::TERMINAL_RESUME_ID_DETECTED,
        origin: EventOrigin::Emit,
        channel: BoundaryChannel::Control,
        loss: LossSemantics::RetainedForReplay,
        legacy_app_behavior: "旧 app 走 DaemonControlMessage::Unknown 静默忽略",
        rationale: "docs/45 事故的正主：它曾掉进 `_ => {}`，导致 resume id 全 null、\
                    恢复出的会话没有历史对话，且不可自愈。daemon 侧留存（上限 1024），\
                    control 重连时补拉——app 可能比会话晚启动。",
    },
    BoundaryEvent {
        name: crate::constants::events::TERMINAL_LAUNCH_WARNING,
        origin: EventOrigin::Emit,
        channel: BoundaryChannel::Control,
        loss: LossSemantics::MustDeliver,
        legacy_app_behavior: "旧 app 走 Unknown 静默忽略",
        rationale: "载荷无 sessionId，必须在 emitter 的 sessionId 守卫之前处理——\
                    否则会被那道守卫整条吞掉。",
    },
    BoundaryEvent {
        name: crate::constants::events::TERMINAL_DESYNC,
        origin: EventOrigin::EmitterGenerated,
        channel: BoundaryChannel::SessionWs,
        loss: LossSemantics::MustDeliver,
        legacy_app_behavior: "旧 app 走 DaemonStreamMessage::Unknown 静默忽略（画面停在旧内容）",
        rationale: "输出队列溢出后的唯一补救信号。丢了 = 前端不知道自己少了数据，\
                    画面永久带缺口。它自己不能再走可丢路径。",
    },
    BoundaryEvent {
        name: "notifier",
        origin: EventOrigin::DedicatedApi,
        channel: BoundaryChannel::Control,
        loss: LossSemantics::MustDeliver,
        legacy_app_behavior: "旧 app 走 Unknown 静默忽略",
        rationale: "waitingInput / sessionExited / cleanup 三类。曾整族静默丢失。\
                    app 侧带去重与「未注册时排队」，所以必达但可延迟。",
    },
];

/// 表中是否已登记该事件。emitter 守卫测试用。
pub fn is_boundary_event(name: &str) -> bool {
    BOUNDARY_EVENTS.iter().any(|e| e.name == name)
}

/// 按通道筛选。双侧穷举测试用。
pub fn events_on_channel(channel: BoundaryChannel) -> impl Iterator<Item = &'static BoundaryEvent> {
    BOUNDARY_EVENTS.iter().filter(move |e| {
        e.channel == channel
            || (channel != BoundaryChannel::Control
                && e.channel == BoundaryChannel::SessionWsWithControlFallback)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_are_unique() {
        let mut names: Vec<&str> = BOUNDARY_EVENTS.iter().map(|e| e.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "契约表里有重名事件");
    }

    #[test]
    fn every_event_documents_legacy_behavior_and_rationale() {
        // 空文案等于没写：后来者看到表却不知道为什么，照样会「看着能改」就改。
        for event in BOUNDARY_EVENTS {
            assert!(
                !event.legacy_app_behavior.trim().is_empty(),
                "{} 缺旧版兼容说明",
                event.name
            );
            assert!(
                !event.rationale.trim().is_empty(),
                "{} 缺语义说明",
                event.name
            );
        }
    }

    #[test]
    fn droppable_events_are_the_exception() {
        // 只有 output 可丢。任何新增的可丢事件都该在这里被人看见并复核——
        // 「丢了没人知道」正是 docs/45 那类事故的形态。
        let droppable: Vec<&str> = BOUNDARY_EVENTS
            .iter()
            .filter(|e| e.loss == LossSemantics::DroppableWithDesync)
            .map(|e| e.name)
            .collect();
        assert_eq!(droppable, vec![crate::constants::events::TERMINAL_OUTPUT]);
    }

    #[test]
    fn is_boundary_event_matches_table() {
        assert!(is_boundary_event(crate::constants::events::TERMINAL_OUTPUT));
        assert!(is_boundary_event("notifier"));
        assert!(!is_boundary_event(
            crate::constants::events::TERMINAL_STATUS
        ));
    }
}
