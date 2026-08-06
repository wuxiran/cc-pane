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
