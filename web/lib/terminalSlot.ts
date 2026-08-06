// 终端创建槽位（docs/78 批4 · acquireTerminalSlot；补账3）。
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

/** 测试用。 */
export function resetTerminalSlots(): void {
  inFlight.clear();
}

/** 观测用：当前在途创建数。 */
export function inFlightSlotCount(): number {
  return inFlight.size;
}
