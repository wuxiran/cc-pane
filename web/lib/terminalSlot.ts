// 终端创建槽位（docs/78）。
//
// 现有防线是 TOCTOU 三段式：check → create → 复查，输了竞态就 kill 回滚
// （TerminalView 与 backgroundLayoutRestore 各一份）。它**正确**但有代价：
// 竞态发生时会真的 spawn 一个 PTY 再杀掉——进程起了又死，daemon 侧留一条
// killed 记录，回滚日志一条。
//
// 槽位把竞态挡在 spawn 之前：同一 (tabId, paneId) 的创建在途时，第二个
// 进入者直接拿不到槽。React19 dev 双挂载、恢复队列与手动重试的交叠、
// 跨端同步触发的重复恢复，都走这一道。
//
// **槽位不取代复查**：它只管"同进程内的并发"，跨进程（另一个桌面实例）
// 的竞态仍靠 canCreateTerminalSession 复查 + 回滚兜底。

const inFlight = new Set<string>();

function slotKey(tabId: string, terminalPaneId: string): string {
  return `${tabId}:${terminalPaneId}`;
}

/**
 * 占坑。返回释放函数；已被占则返回 null（调用方应放弃本次创建）。
 * 释放函数幂等——finally 与 catch 里都调也无害。
 */
export function acquireTerminalSlot(
  tabId: string,
  terminalPaneId: string,
): (() => void) | null {
  const key = slotKey(tabId, terminalPaneId);
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight.delete(key);
  };
}

/**
 * 一次创建流程的槽位持有者（docs/78 批4）。
 *
 * spawn 路径的申请点与释放点隔着 try/catch——catch 看不见 try 内的绑定，而
 * 失败路径必须能释放（否则该 (tabId, paneId) 永久无法创建）。持有者把这段
 * 记账收进来，调用点只剩 acquire/release 两行。
 *
 * 无 tabId/paneId 身份（弹窗预览等无标签视图）时视为占到：没有身份就无从记账，
 * 挡住反而会让这些视图永远建不出会话。
 */
export interface TerminalSlotHolder {
  acquire(tabId?: string, terminalPaneId?: string): boolean;
  /** 幂等，成功与失败路径都可调。 */
  release(): void;
}

export function createTerminalSlotHolder(): TerminalSlotHolder {
  let release: (() => void) | null = null;
  return {
    acquire(tabId, terminalPaneId) {
      if (!tabId || !terminalPaneId) return true;
      release = acquireTerminalSlot(tabId, terminalPaneId);
      return release !== null;
    },
    release() {
      release?.();
      release = null;
    },
  };
}

/** 测试用。 */
export function resetTerminalSlots(): void {
  inFlight.clear();
}

/** 观测用：当前在途创建数。 */
export function inFlightSlotCount(): number {
  return inFlight.size;
}
