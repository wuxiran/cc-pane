export const MAX_TERMINAL_WEBGL_CONTEXTS = 8;
/** 隐藏持有者最多占用的 context 数；可见者永不被逐出（docs/107 P1）。 */
export const MAX_HIDDEN_TERMINAL_WEBGL_CONTEXTS = 6;

interface TerminalWebglBudgetOptions {
  hiddenLimit?: number;
  now?: () => number;
}

/** One pool per WebView. Waiting controllers never create an extra context. */
export function createTerminalWebglBudget(
  limit = MAX_TERMINAL_WEBGL_CONTEXTS,
  { hiddenLimit = MAX_HIDDEN_TERMINAL_WEBGL_CONTEXTS, now = () => Date.now() }: TerminalWebglBudgetOptions = {},
) {
  type Entry = {
    grant: () => void; visible: () => boolean; revoke?: () => void;
    /** 首次观察到隐藏的时刻（acquire/sweep 时采样）；可见时为 null。 */
    hiddenAt: number | null; hiddenSeq: number;
  };
  const active = new Map<object, Entry>();
  const waiting = new Map<object, Entry>();
  let scheduled = false;
  let seq = 0;
  // 可见性是轮询得到的：这里只在有人申请/释放时刷一遍，hiddenAt 是「首次观察到隐藏」。
  const sweep = () => {
    for (const entry of active.values()) {
      if (entry.visible()) { entry.hiddenAt = null; continue; }
      if (entry.hiddenAt === null) { entry.hiddenAt = now(); entry.hiddenSeq = ++seq; }
    }
  };
  const hiddenCount = () => [...active.values()].filter((entry) => entry.hiddenAt !== null).length;
  const evictOldestHidden = (): boolean => {
    let victim: [object, Entry] | null = null;
    for (const pair of active) {
      const entry = pair[1];
      if (entry.hiddenAt === null) continue;
      if (!victim || entry.hiddenAt < victim[1].hiddenAt! || (entry.hiddenAt === victim[1].hiddenAt && entry.hiddenSeq < victim[1].hiddenSeq)) victim = pair;
    }
    if (!victim) return false;
    active.delete(victim[0]);
    victim[1].revoke?.();
    waiting.set(victim[0], victim[1]);
    return true;
  };
  const drain = () => {
    scheduled = false;
    sweep();
    const queue = [...waiting].sort((a, b) => Number(b[1].visible()) - Number(a[1].visible()));
    for (const [owner, entry] of queue) {
      if (active.size >= limit) break;
      // 隐藏等待者受 hiddenLimit 约束：留在队列里等可见或等别人释放。
      if (!entry.visible() && hiddenCount() >= hiddenLimit) continue;
      if (!waiting.delete(owner)) continue;
      entry.grant();
    }
  };
  return {
    acquire(owner: object, grant: () => void, visible: () => boolean, revoke?: () => void): boolean {
      if (active.has(owner)) return true;
      sweep();
      // 隐藏持有者超额：按最早隐藏者逐出（LRU），绝不动可见者。
      while (hiddenCount() > hiddenLimit && evictOldestHidden()) { /* keep evicting */ }
      const isVisible = visible();
      // A rapid layout cycle can revisit hidden panes before their debounce
      // expires. Visible panes must reclaim those leases instead of staying DOM.
      if (active.size >= limit && isVisible) evictOldestHidden();
      if (active.size >= limit || (!isVisible && hiddenCount() >= hiddenLimit)) {
        waiting.set(owner, { grant, visible, revoke, hiddenAt: null, hiddenSeq: 0 });
        return false;
      }
      waiting.delete(owner);
      active.set(owner, {
        grant, visible, revoke, hiddenAt: isVisible ? null : now(), hiddenSeq: isVisible ? 0 : ++seq,
      });
      return true;
    },
    release(owner: object): void {
      waiting.delete(owner);
      active.delete(owner);
      if (!scheduled && waiting.size > 0) { scheduled = true; queueMicrotask(drain); }
    },
    /** 重新采样可见性并把隐藏超额者逐出（lifecycle 边沿可调；acquire 内部也会做）。 */
    sweep(): void {
      sweep();
      while (hiddenCount() > hiddenLimit && evictOldestHidden()) { /* keep evicting */ }
    },
    count: () => active.size,
    hiddenCount,
    /** 测试用：单例在用例间清空（未 dispose 的 controller 会泄漏租约）。 */
    _resetForTest(): void { active.clear(); waiting.clear(); },
  };
}

export const terminalWebglBudget = createTerminalWebglBudget();
