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
//!
//! # 方向说明
//!
//! [`BOUNDARY_EVENTS`] 只覆盖 **daemon → app** 出站方向；反向（app → daemon
//! 的 control 入站消息）见 [`INBOUND_CONTROL_MESSAGES`]——同一种契约，
//! 漏接的下场也相同（daemon 侧 `#[serde(other)] Unknown` 静默吞掉）。

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
    /// 可丢但重发：单次丢失无补救通道，但 daemon 周期扫描会再次发起
    /// （条件仍满足时）。与 DroppableWithDesync 不同——它不依赖 desync 重放，
    /// 也**不该**被算进「可丢事件例外」断言（那条只锁 output 独占的 desync 语义）。
    BestEffortWithResend,
    /// 可丢但留存：daemon 侧留副本，客户端重连时补拉。
    RetainedForReplay,
}

/// 事件从哪里进入跨界通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventOrigin {
    /// 经 `EventEmitter::emit` 进来——**这类必须在 emit 里有非默认分支**，
    /// 否则落进 `_ => {}` 静默丢失（docs/45 事故形态）。
    Emit,
    /// emitter 自己生成的出站信号，不经 emit（如队列排空后插入的 desync 标记）。
    ///
    /// **给既有 EmitterGenerated 事件新增 emit 调用点时，必须把 origin 改成
    /// Emit**——本分类会让穷举守卫跳过该事件，emit 侧缺分支就是静默丢失。
    /// 0.12.7 的 terminal-desync 正是这么漏的：契约表登记时它确实只有 emitter
    /// 自生成一种来源，后来 reader 线程加了两处 `emit(TERMINAL_DESYNC)`，
    /// 分类没跟着改，两处全落 `_ => {}`，守卫全绿。
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
        origin: EventOrigin::Emit,
        channel: BoundaryChannel::SessionWs,
        loss: LossSemantics::MustDeliver,
        legacy_app_behavior: "旧 app 走 DaemonStreamMessage::Unknown 静默忽略（画面停在旧内容）",
        rationale: "输出丢失后的唯一补救信号。丢了 = 前端不知道自己少了数据，\
                    画面永久带缺口。它自己不能再走可丢路径。来源有两类：reader \
                    线程经 emit（Stage 4 ack 静默看门狗、合批通道溢出）——origin \
                    按这类记 Emit，让穷举守卫盯住 emit 分支（0.12.7 曾因误标 \
                    EmitterGenerated 被守卫跳过，两处 emit 全落 `_ => {}`）；\
                    另有 emitter 自生成路径（WS 队列排空后插入、unhide 补发），\
                    由 ws_emitter 自己的测试覆盖。",
    },
    BoundaryEvent {
        name: crate::constants::events::TERMINAL_CHECKPOINT_REQUEST,
        origin: EventOrigin::DedicatedApi,
        channel: BoundaryChannel::Control,
        loss: LossSemantics::BestEffortWithResend,
        legacy_app_behavior: "旧 app 走 DaemonControlMessage::Unknown 静默忽略",
        rationale: "补拍语义（M3b-2）：会话照片锚点之后的 delta 超 4MB 阈值时，daemon \
                    30s 周期扫描经 control 催前端重拍上传，每会话节流 ≥60s。丢了不致命\
                    ——条件仍满足时下一轮扫描会重发，照片只是暂时变旧；首拍由前端边沿\
                    触发，无照片的会话不催。",
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

/// 入站控制消息（app → daemon）的契约。
///
/// 出站表覆盖不到这个方向：daemon 侧 `ControlInboundMessage` 的
/// `#[serde(other)] Unknown` 会把没接上的入站消息静默吞掉，与出站
/// `_ => {}` 是同一种病。TS 镜像（`daemonEventContract.ts`）的扫源测试
/// 会核对键集、daemon 接收变体与 app 发送点三者都存在。
#[derive(Debug, Clone, Copy)]
pub struct InboundControlMessage {
    /// serde tag（control-ws：`{"type": ...}`，camelCase；daemon 侧变体名 =
    /// 首字母大写）或逻辑名（rest：无 serde tag，靠路由配对）。
    pub name: &'static str,
    /// 入站通道："control-ws"（`/ws/control` 单帧）或 "rest"（独立 HTTP 请求，
    /// 大 payload / 需要应答的离散提交走这里，不占 control 队头）。
    pub channel: &'static str,
    /// daemon 侧在哪里消费它。
    pub daemon_handler: &'static str,
    /// app 侧从哪里发出。
    pub app_sender: &'static str,
    pub rationale: &'static str,
}

/// 全部入站控制消息。**新增入站消息必须先在这里加一行。**
pub const INBOUND_CONTROL_MESSAGES: &[InboundControlMessage] = &[
    InboundControlMessage {
        name: "hiddenSessions",
        channel: "control-ws",
        daemon_handler:
            "server.rs ControlInboundMessage::HiddenSessions → clear/set_hidden_sessions",
        app_sender: "terminal_daemon_control_link（连接建立补发 + watch 变更推送）",
        rationale: "后台会话断流门（docs/78）。best-effort：旧 daemon 静默忽略、断线期间\
                    无投递——app 侧不得据此放松前端 512KB 积压兜底。",
    },
    InboundControlMessage {
        name: "identityAck",
        channel: "control-ws",
        daemon_handler:
            "server.rs ControlInboundMessage::IdentityAck → ws_emitter.ack_identity_events",
        app_sender: "terminal_daemon_control_link（replay/live 绑定完成后经 ack 队列逐批发送）",
        rationale: "身份事件留存的 outbox ack（docs/86 3.1）：消费方确认后移除，消解 app \
                    每次重启全量重放历史事件的写风暴。只删 resumeId 一致的条目（换 id 的\
                    新事件存活）；ack 丢失由重连补拉的「已应用」路径补发（自愈）。旧 daemon \
                    静默忽略——留存照旧累积，行为不劣化。",
    },
    InboundControlMessage {
        name: "outputAck",
        channel: "control-ws",
        daemon_handler:
            "server.rs ControlInboundMessage::OutputAck → terminal_backend.ack_terminal_output",
        app_sender: "terminal_daemon_control_link（watch 待发队列，链路空闲时排空推送）",
        rationale: "输出投递回执（docs/71 §9.2 B-5）：把「前端已消化到哪个累计 endSeq」报回\
                    产出侧，让上游第一次看得见下游的消费速度，作为生产者暂停的水位输入。\
                    语义是「解析完**或**被任何丢弃路径丢弃」——后台标签收进隐藏积压同样算，\
                    否则回执永不推进、窗口关死、生产者永久暂停。累计值 + max-merge：重复\
                    投递不重复计费、乱序不倒退、丢一条下次自愈，故 best-effort 即可，不补发。\
                    旧 daemon 静默忽略——`ever_acked` 保持 false，闸门据此降级放行，\
                    行为等同回执机制之前，不劣化。",
    },
    InboundControlMessage {
        name: "checkpointUpload",
        channel: "rest",
        daemon_handler: "server.rs upload_session_checkpoint（POST /api/sessions/{id}/checkpoint）",
        app_sender:
            "terminal_commands::upload_terminal_checkpoint → daemon_client.upload_checkpoint",
        rationale: "照片是大 payload（数百 KB–4MB）的离散提交，需要应答（409 拒收可感知、\
                    404 = capability 探测），且不能被 coalesce——走 REST 而非 control \
                    单帧通道（M3b §3 选型）。写权限过 ensure_may_write（只读镜像不得上传）。",
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
    fn inbound_messages_are_unique_and_documented() {
        let mut names: Vec<&str> = INBOUND_CONTROL_MESSAGES.iter().map(|m| m.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "入站契约表里有重名消息");
        for message in INBOUND_CONTROL_MESSAGES {
            assert!(
                matches!(message.channel, "control-ws" | "rest"),
                "{} 的 channel 必须是 control-ws 或 rest，实为 {}",
                message.name,
                message.channel
            );
            assert!(
                !message.daemon_handler.trim().is_empty(),
                "{} 缺 daemon 侧 handler 说明",
                message.name
            );
            assert!(
                !message.app_sender.trim().is_empty(),
                "{} 缺 app 侧发送点说明",
                message.name
            );
            assert!(
                !message.rationale.trim().is_empty(),
                "{} 缺语义说明",
                message.name
            );
        }
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
