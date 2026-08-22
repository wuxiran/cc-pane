// 投递信用原语（docs/71 §9.2 缺口 B-5）。移植自 Orca
// `src/renderer/src/lib/pane-manager/terminal-delivery-credit.ts`（59892a2f13）。
//
// 解决的问题：`terminalWriteFlowControl.ts` 的信用窗口只在渲染进程内生效，Rust
// 侧完全看不见——队列压力只是从 xterm **前移**到 WS/Tauri IPC，并没有消失。
// Orca 在 `src/main/ipc/terminal-pty-ack-gate.ts:87-94` 记录了他们踩过的同一个坑：
// 在入队时就 ACK，等于告诉上游"我消化完了"而实际只是"我收到了"，上游看不到背压
// 继续灌，渲染队列在瞬时 ACK 背后无界增长，最终撞上 pending cap 开始丢数据——
// 一个为了防丢数据而建的窗口，因为记账点错了反而导致丢数据。
//
// 所以信用必须归还在**消费点**：chunk 被 xterm 解析完，**或**被任何一条丢弃路径
// 丢掉。fire-once，重复调用安全；**遗漏一次就永久缩小上游窗口**。
//
// 用法：分发方用 deliverTerminalDataWithDeferredCredit 包住同步分发；分发过程中
// 任何一个消费者调 takeCurrentTerminalDeliveryCredit() 认领一份信用，稍后自己决定
// 何时归还。没人认领时，信用在 deliver 返回时自动归还（同步丢弃路径的兜底）。

interface TerminalDeliveryCredit {
  complete: () => void;
  /** deliver 仍在栈上：此时还可能有新的认领，不能提前判定归还完毕。 */
  open: boolean;
  pendingClaims: number;
  completed: boolean;
}

// 认领是同步的；嵌套时内层回调返回后要恢复外层，否则外层的后续认领会挂错账。
let currentDeliveryCredit: TerminalDeliveryCredit | null = null;

function settle(credit: TerminalDeliveryCredit): void {
  if (credit.completed || credit.open || credit.pendingClaims > 0) return;
  credit.completed = true;
  credit.complete();
}

/**
 * 跑一次分发，并把上游信用推迟到所有消费者解析或丢弃之后再归还。
 *
 * `deliver` 必须是同步的——信用的认领窗口就是它的执行期间。
 */
export function deliverTerminalDataWithDeferredCredit(
  complete: () => void,
  deliver: () => void,
): void {
  const credit: TerminalDeliveryCredit = {
    complete,
    open: true,
    pendingClaims: 0,
    completed: false,
  };
  const previous = currentDeliveryCredit;
  currentDeliveryCredit = credit;
  try {
    deliver();
  } finally {
    currentDeliveryCredit = previous;
    credit.open = false;
    // 无人认领 → 这里立刻归还。消费者若整段丢弃了数据而没认领，信用也不会漏。
    settle(credit);
  }
}

/**
 * 认领当前分发的一份信用，返回归还函数（幂等）。
 *
 * 不在分发期间调用返回 null——调用方此时无需归还任何东西。
 */
export function takeCurrentTerminalDeliveryCredit(): (() => void) | null {
  const credit = currentDeliveryCredit;
  if (!credit || !credit.open) return null;
  credit.pendingClaims += 1;
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    credit.pendingClaims -= 1;
    settle(credit);
  };
}
