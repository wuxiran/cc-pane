// 跨 daemon 边界事件契约表（TS 侧镜像，docs/78 §3）。
//
// 与 Rust 侧 `cc-panes-core/src/services/boundary_events.rs` **一一对应**。
// 跨语言无法共享源码，所以靠两边各自的穷举测试 + 键集清单一致来守——
// 评审时 diff 两份 EVENT_NAMES 即可。
//
// 为什么要有 TS 这一份：app 侧的分发散在三处（Rust 的 DaemonStreamMessage、
// Rust 的 DaemonControlMessage、以及 web 直连模式下 TS 的 ad-hoc 解析），
// 三者互相独立、此前没有共同的表。漏一个的后果是 docs/45 那类静默丢失。

/** 事件走哪条跨界通道。 */
export type BoundaryChannel = "session-ws" | "control" | "session-ws-with-control-fallback";

/** 事件从哪里进入跨界通道。 */
export type EventOrigin = "emit" | "emitter-generated" | "dedicated-api";

export interface BoundaryEventContract {
  name: string;
  origin: EventOrigin;
  channel: BoundaryChannel;
  /** app 侧在哪里消费它。空 = 本模式下不消费（需在 rationale 里说明）。 */
  appHandler: string;
  rationale: string;
}

/**
 * 全部跨界事件。**键集必须与 Rust 侧 BOUNDARY_EVENTS 完全一致。**
 */
export const BOUNDARY_EVENTS: readonly BoundaryEventContract[] = [
  {
    name: "terminal-output",
    origin: "emit",
    channel: "session-ws",
    appHandler: "terminalService.ensureListeners / ensureWebSocket",
    rationale: "唯一高频事件。溢出整段丢弃并发 desync，前端走快照重建。",
  },
  {
    name: "terminal-exit",
    origin: "emit",
    channel: "session-ws-with-control-fallback",
    appHandler: "terminalService.ensureListeners（dispatchExit）",
    rationale: "丢了前端永远显示「运行中」的死会话。",
  },
  {
    name: "session-killed",
    origin: "emit",
    channel: "session-ws-with-control-fallback",
    appHandler: "terminalService.ensureListeners（按 KillReason 分流）",
    rationale: "回收类 reason 保留标签，其余关标签——映射错了标签就关不掉。",
  },
  {
    name: "terminal-resume-id-detected",
    origin: "emit",
    channel: "control",
    appHandler: "terminal_daemon_control_link（BindResume，绕过 WebView 门禁直接落库）",
    rationale: "docs/45 事故正主。曾掉进 `_ => {}` 导致 resume id 全 null 且不可自愈。",
  },
  {
    name: "terminal-launch-warning",
    origin: "emit",
    channel: "control",
    appHandler: "terminal_daemon_control_link（Emit）",
    rationale: "载荷无 sessionId，必须在 emitter 的 sessionId 守卫之前处理。",
  },
  {
    name: "terminal-desync",
    origin: "emitter-generated",
    channel: "session-ws",
    appHandler: "terminalService.ensureListeners → createTerminalDesyncHandler",
    rationale: "溢出后的唯一补救信号，不经 emit（emitter 排空队列后自行插入）。",
  },
  {
    name: "notifier",
    origin: "dedicated-api",
    channel: "control",
    appHandler: "terminal_daemon_control_link（Notify，带去重与未注册排队）",
    rationale: "waitingInput / sessionExited / cleanup 三类，曾整族静默丢失。",
  },
  {
    name: "terminal-checkpoint-request",
    origin: "dedicated-api",
    channel: "control",
    appHandler: "terminal_daemon_control_link（Emit → EV::TERMINAL_CHECKPOINT_REQUEST）",
    rationale:
      "daemon 补拍请求（M3b-2）：照片锚点后 delta 超 4MB 时催前端重拍。best-effort：丢了 30s 周期扫描会重发（每会话节流 ≥60s），无照片不催。",
  },
] as const;

/** 键集。与 Rust 侧 diff 用。 */
export const BOUNDARY_EVENT_NAMES: readonly string[] = BOUNDARY_EVENTS.map((e) => e.name);

export function findBoundaryEvent(name: string): BoundaryEventContract | undefined {
  return BOUNDARY_EVENTS.find((e) => e.name === name);
}

/**
 * 该事件在 Tauri 模式下是否由前端 `terminalService` 直接监听。
 *
 * control 通道的事件由 Rust 侧消费后再转成 WebView 事件，前端不直接听——
 * 这个区分决定了前端的监听器清单该有哪些。
 */
export function isFrontendListenedEvent(name: string): boolean {
  const event = findBoundaryEvent(name);
  if (!event) return false;
  return event.channel !== "control";
}

/**
 * 入站控制消息（app → daemon）的契约。BOUNDARY_EVENTS 只覆盖 daemon → app
 * 出站方向；这张表补上反向——它同样是跨界契约，漏了同样死得无声（daemon 侧
 * `#[serde(other)] Unknown` 会把没接上的入站消息静默吞掉，与出站 `_ => {}`
 * 是同一种病）。键集与 Rust 侧 INBOUND_CONTROL_MESSAGES 一致。
 */
export interface InboundControlContract {
  /** serde tag（control-ws：`{"type": ...}`，camelCase；daemon 侧变体名 = 首字母大写）
   *  或逻辑名（rest：无 serde tag，靠路由配对）。 */
  name: string;
  /** 入站通道：control-ws（`/ws/control` 单帧）或 rest（独立 HTTP 请求，
   *  大 payload / 需要应答的离散提交走这里，不占 control 队头）。 */
  channel: "control-ws" | "rest";
  /** daemon 侧在哪里消费它。 */
  daemonHandler: string;
  /** app 侧从哪里发出。 */
  appSender: string;
  rationale: string;
}

export const INBOUND_CONTROL_MESSAGES: readonly InboundControlContract[] = [
  {
    name: "hiddenSessions",
    channel: "control-ws",
    daemonHandler: "server.rs ControlInboundMessage::HiddenSessions → clear/set_hidden_sessions",
    appSender: "terminal_daemon_control_link（连接建立补发 + watch 变更推送）",
    rationale:
      "后台会话断流门。best-effort：旧 daemon 静默忽略、断线期间无投递，前端 512KB 积压是永久兜底。",
  },
  {
    name: "identityAck",
    channel: "control-ws",
    daemonHandler: "server.rs ControlInboundMessage::IdentityAck → ws_emitter.ack_identity_events",
    appSender: "terminal_daemon_control_link（replay/live 绑定完成后经 ack 队列逐批发送）",
    rationale:
      "身份事件留存的 outbox ack（docs/86 3.1）：消费方确认后移除，消解 app 重启全量重放风暴。只删 resumeId 一致的条目；ack 丢失由重连补拉的「已应用」路径补发。旧 daemon 静默忽略，不劣化。",
  },
  {
    name: "checkpointUpload",
    channel: "rest",
    daemonHandler: "server.rs upload_session_checkpoint（POST /api/sessions/{id}/checkpoint）",
    appSender: "terminal_commands::upload_terminal_checkpoint → daemon_client.upload_checkpoint",
    rationale:
      "照片是大 payload 的离散提交，需要应答（409 拒收可感知、404 = capability 探测），走 REST 而非 control 单帧通道（M3b §3 选型）。",
  },
] as const;

/** 入站消息键集。与 Rust 侧 diff 用。 */
export const INBOUND_CONTROL_MESSAGE_NAMES: readonly string[] = INBOUND_CONTROL_MESSAGES.map(
  (m) => m.name,
);
