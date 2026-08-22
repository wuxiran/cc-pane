// 后台终端积压的**全局共享预算**（docs/71 §3.3 差异 2「全局预算」）。
//
// 现状每个 TerminalHiddenWriteBuffer 各占 512KB（terminalHiddenWriteBuffer.ts:34），
// 18 个后台标签 = 9MB 上限。这正是 §1 B 类症状的根因形状：每个终端各算各的，
// N 个会话 = N 份独立上限。Orca 的对应机制按活跃后台数动态收缩每份 keep-tail，
// 让总量恒定（`daemon-stream-keep-tail-drop.ts:60-68`）。
//
// **这是收紧不是放松**：单标签仍拿满 512KB，多标签时每份变小、总量封顶 ~2MB。
// 代价是多标签场景溢出更频繁 → 更多 snapshot 重放，属预期取舍——重放一次的成本
// 远低于常驻 9MB。前端 512KB 兜底的语义（useHiddenSessionReporter.ts:7-9）不受
// 影响：那条说的是"不得因为 daemon 上报就放松兜底"，与本模块正交。

/** 全部后台终端的积压总预算。 */
export const HIDDEN_BACKLOG_GLOBAL_BUDGET_CHARS = 2 * 1024 * 1024;
/** 单个终端的上限（= 旧的固定值）。只有一个后台终端时它拿满这么多。 */
export const HIDDEN_BACKLOG_MAX_PER_TERMINAL_CHARS = 512 * 1024;
/**
 * 单个终端的下限。必须够放下一整屏 TUI 重绘（~cols×rows×SGR ≈ 100KB），
 * 否则常规重绘就能把缓冲顶爆，切回来永远在走 snapshot 重放。
 */
export const HIDDEN_BACKLOG_MIN_PER_TERMINAL_CHARS = 64 * 1024;

/** killswitch：置 false 回退到每终端固定 512KB。 */
export const HIDDEN_BACKLOG_SHARED_BUDGET_ENABLED: boolean = true;

/** 当前登记在案的后台终端。用身份对象而非 sessionId：同一会话可能有多个视图
 *  （主标签 + 星标镜像），各自持有独立缓冲，预算要按缓冲个数分。 */
const registered = new Set<object>();

/** 按当前后台终端数算单份配额。 */
export function hiddenBacklogQuotaChars(hiddenCount: number = registered.size): number {
  if (!HIDDEN_BACKLOG_SHARED_BUDGET_ENABLED) {
    return HIDDEN_BACKLOG_MAX_PER_TERMINAL_CHARS;
  }
  const share = Math.floor(HIDDEN_BACKLOG_GLOBAL_BUDGET_CHARS / Math.max(1, hiddenCount));
  return Math.min(
    HIDDEN_BACKLOG_MAX_PER_TERMINAL_CHARS,
    Math.max(HIDDEN_BACKLOG_MIN_PER_TERMINAL_CHARS, share),
  );
}

/** 终端转入后台：登记进预算分母。重复登记幂等。 */
export function registerHiddenTerminal(owner: object): void {
  registered.add(owner);
}

/** 终端转回前台或销毁：移出分母，其余终端的配额随之回升。 */
export function unregisterHiddenTerminal(owner: object): void {
  registered.delete(owner);
}

/** 诊断用。 */
export function hiddenTerminalCount(): number {
  return registered.size;
}

/** 测试用。 */
export function _resetHiddenBudgetForTest(): void {
  registered.clear();
}
