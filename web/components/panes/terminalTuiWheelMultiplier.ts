import type { Terminal } from "@xterm/xterm";

import {
  createTerminalTuiWheelDistanceState,
  normalizeTerminalTuiWheelMultiplier,
  resolveTerminalTuiWheelReportCount,
  resolveTerminalWheelDirection,
  type TerminalTuiWheelDistanceState,
} from "./terminalTuiWheelReports";

/**
 * 给**自己处理滚动的全屏 TUI** 补足滚轮距离。
 *
 * 背景：xterm 的 `consumeWheelEvent` 会抑制小像素增量，开了鼠标上报的 TUI
 * （grok / opencode）因此滚一下只动一行。这里按实际行距补发等量的
 * line-mode WheelEvent，让 TUI 每行收到一个鼠标报告。做法参考 Orca 的
 * `pane-terminal-mouse-wheel.ts`。
 *
 * **必须走 `attachCustomWheelEventHandler` 而不是自己 addEventListener**：
 * xterm 的滚轮监听挂在 `term.element` 上（`bindMouse(){ let i=this.element }`），
 * 自己往同一个元素挂监听会变成两条并行链路——`stopPropagation()` 挡不住同元素
 * 上的其它监听器（那要 `stopImmediatePropagation`），结果是应用每次滚轮都收到
 * 重复输入。这正是上一版自造「滚轮→方向键」被删掉的原因，别再走回去。
 *
 * 三条不介入的边界：
 * - **应用没开鼠标上报**：交给 xterm 原生处理（普通缓冲滚 scrollback；
 *   alt-buffer 由 xterm 自己发 DECCKM 正确的方向键）。
 * - **Shift**：终端惯例的「绕过鼠标上报」手势，不能被我们放大。
 * - **补发出来的事件**：靠标记识别，否则无限递归。
 */

const XTERM_MOUSE_REPORTING_CLASS = "enable-mouse-events";
const REPLAYED_WHEEL_EVENT_PROPERTY = "__ccPanesReplayedTerminalWheelEvent";
const DOM_DELTA_LINE = 1;

type TerminalWheelTarget = Pick<
  Terminal,
  "attachCustomWheelEventHandler" | "element" | "rows"
> & {
  modes: Pick<Terminal["modes"], "mouseTrackingMode">;
};

export interface TerminalTuiWheelMultiplierOptions {
  /** 用户可调倍率（1..10）。缺省 = 1，此时只有距离模型生效。 */
  getMultiplier?: () => number | undefined;
}

type ReplayedWheelEvent = WheelEvent & {
  [REPLAYED_WHEEL_EVENT_PROPERTY]?: boolean;
};

interface WheelReplayState {
  distance: TerminalTuiWheelDistanceState;
  drainScheduled: boolean;
  pendingDirection: -1 | 0 | 1;
  pendingEvent: WheelEvent | null;
  pendingReports: number;
  pendingTarget: EventTarget | null;
}

function createWheelReplayState(): WheelReplayState {
  return {
    distance: createTerminalTuiWheelDistanceState(),
    drainScheduled: false,
    pendingDirection: 0,
    pendingEvent: null,
    pendingReports: 0,
    pendingTarget: null,
  };
}

function isReplayedWheelEvent(event: WheelEvent): boolean {
  return (event as ReplayedWheelEvent)[REPLAYED_WHEEL_EVENT_PROPERTY] === true;
}

function markReplayedWheelEvent(event: WheelEvent): void {
  Object.defineProperty(event, REPLAYED_WHEEL_EVENT_PROPERTY, {
    configurable: true,
    value: true,
  });
}

/**
 * 克隆成 line-mode、单行增量的事件。坐标等字段照抄——鼠标报告要带位置，
 * TUI 靠它决定滚哪个控件。
 */
function cloneWheelReportEvent(event: WheelEvent): WheelEvent {
  const clone = new WheelEvent(event.type, {
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
    view: event.view,
    detail: event.detail,
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
    relatedTarget: event.relatedTarget,
    deltaX: 0,
    deltaY: event.deltaY < 0 ? -1 : 1,
    deltaZ: 0,
    deltaMode: DOM_DELTA_LINE,
  });
  markReplayedWheelEvent(clone);
  return clone;
}

function resolveTerminalWheelCellHeight(terminal: TerminalWheelTarget): number | undefined {
  if (typeof terminal.element?.querySelector !== "function") return undefined;
  const screen = terminal.element.querySelector<HTMLElement>(".xterm-screen");
  const rect = screen?.getBoundingClientRect();
  if (!rect || rect.height <= 0 || terminal.rows <= 0) return undefined;
  return rect.height / terminal.rows;
}

/** 该不该放大：只对「真的在上报鼠标、且非补发、非 Shift」的竖向滚动生效。 */
export function shouldMultiplyTerminalWheel(
  event: WheelEvent,
  terminalElement: HTMLElement | null | undefined,
): boolean {
  return !(
    isReplayedWheelEvent(event) ||
    !terminalElement?.classList.contains(XTERM_MOUSE_REPORTING_CLASS) ||
    event.deltaY === 0 ||
    event.shiftKey
  );
}

function drainWheelReports(state: WheelReplayState, terminal: TerminalWheelTarget): void {
  const target = state.pendingTarget;
  const event = state.pendingEvent;
  const reset = () => {
    state.pendingReports = 0;
    state.drainScheduled = false;
    state.pendingDirection = 0;
    state.pendingEvent = null;
    state.pendingTarget = null;
  };

  if (!target || !event || state.pendingReports <= 0) {
    state.drainScheduled = false;
    return;
  }

  // 排到这一刻应用可能已经关掉鼠标上报（TUI 退出/切界面），此时补发出去的
  // 事件会被 xterm 当普通滚轮处理，平白多滚。丢掉更安全。
  if (terminal.modes.mouseTrackingMode === "none") {
    reset();
    return;
  }

  const reportsToDispatch = state.pendingReports;
  for (let i = 0; i < reportsToDispatch; i += 1) {
    target.dispatchEvent(cloneWheelReportEvent(event));
  }
  reset();
}

function queueWheelReports(
  state: WheelReplayState,
  terminal: TerminalWheelTarget,
  target: EventTarget,
  event: WheelEvent,
  reportCount: number,
): void {
  if (reportCount <= 0) return;

  const direction = resolveTerminalWheelDirection(event);
  // 换向时丢掉还没发出去的反向报告，否则会先往回滚一段。
  if (state.pendingDirection !== 0 && state.pendingDirection !== direction) {
    state.pendingReports = 0;
  }

  state.pendingDirection = direction;
  state.pendingEvent = event;
  state.pendingTarget = target;
  state.pendingReports += reportCount;

  if (state.drainScheduled) return;
  state.drainScheduled = true;
  // 排到 xterm 处理完原事件之后再补发；**不按帧节流**——全屏 TUI 需要完整的
  // 滚轮距离，压帧会让快滚丢行。
  queueMicrotask(() => {
    drainWheelReports(state, terminal);
  });
}

export function attachTerminalTuiWheelMultiplier(
  terminal: TerminalWheelTarget,
  options: TerminalTuiWheelMultiplierOptions = {},
): void {
  // 旧版 xterm 或测试替身可能没有这两个能力，缺了就整个不启用（不抛）。
  if (
    typeof terminal.attachCustomWheelEventHandler !== "function" ||
    typeof terminal.modes?.mouseTrackingMode !== "string"
  ) {
    return;
  }

  const replayState = createWheelReplayState();

  terminal.attachCustomWheelEventHandler((event) => {
    if (
      terminal.modes.mouseTrackingMode === "none" ||
      !shouldMultiplyTerminalWheel(event, terminal.element)
    ) {
      return true;
    }

    const target =
      event.currentTarget instanceof EventTarget ? event.currentTarget : terminal.element;
    if (!target) return true;

    const reportCount = resolveTerminalTuiWheelReportCount(
      event,
      normalizeTerminalTuiWheelMultiplier(options.getMultiplier?.()),
      replayState.distance,
      {
        cellHeight: resolveTerminalWheelCellHeight(terminal),
        rows: terminal.rows,
      },
    );
    queueWheelReports(replayState, terminal, target, event, reportCount);

    // 原事件不再由 xterm 发报告——它的报告数由上面的补发决定。
    return false;
  });
}
