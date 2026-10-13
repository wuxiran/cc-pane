/**
 * 重放信号量（docs/107 P1）：`terminalRestoreQueue` 只管 PTY 创建的并发，
 * 而 snapshot / 冷恢复 / 休眠唤醒 / desync 重同步这四条**重放**入口此前不限
 * 并发——30 标签冷恢复时 30 份 checkpoint+delta 同时解析、同时喂 xterm，
 * 主线程被打成一团。这里收口为优先级信号量：并发 1，前台（可见）视图优先级 0
 * 插队，其他 1；单任务 30 s 超时**释放槽位**（任务自身继续跑，结果照常返回），
 * 排队期间若已取消（卸载/epoch 翻转）直接拒绝，不占槽。
 *
 * 注意不可重入：被包的四个入口互不嵌套（`replayAttachOrWake` 内部直接调
 * `replayAttachedSession` 函数而非包装后的调用点），新增包装点前先确认。
 */

export const TERMINAL_REPLAY_TIMEOUT_MS = 30_000;
export const TERMINAL_REPLAY_PRIORITY_FOREGROUND = 0;
export const TERMINAL_REPLAY_PRIORITY_BACKGROUND = 1;
const TERMINAL_REPLAY_CANCELLED = "cc-panes.terminal-replay-cancelled";

export interface TerminalReplayRunOptions {
  /** 越小越先；默认后台。 */
  priority?: number;
  /** 出队时为真则拒绝（错误可用 isTerminalReplayCancelled 判定），不占槽。 */
  isCancelled?: () => boolean;
  /** 诊断标签。 */
  label?: string;
}

interface QueueItem {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  priority: number;
  seq: number;
  isCancelled?: () => boolean;
  label?: string;
}

export interface TerminalReplaySemaphore {
  run<T>(task: () => Promise<T>, options?: TerminalReplayRunOptions): Promise<T>;
  getSnapshot(): { active: number; pending: number };
  /** 测试用：丢弃排队项并清零占用（单例跨用例时，未 settle 的 mock 会把槽位占到 30 s 超时）。 */
  _resetForTest(): void;
}

interface CreateTerminalReplaySemaphoreOptions {
  concurrency?: number;
  timeoutMs?: number;
  onTimeout?: (label: string | undefined, elapsedMs: number) => void;
}

export function createTerminalReplayCancelledError(): Error {
  const error = new Error("Terminal replay cancelled");
  (error as Error & { code?: string }).code = TERMINAL_REPLAY_CANCELLED;
  return error;
}

export function isTerminalReplayCancelled(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { code?: string }).code === TERMINAL_REPLAY_CANCELLED;
}

export function createTerminalReplaySemaphore({
  concurrency = 1,
  timeoutMs = TERMINAL_REPLAY_TIMEOUT_MS,
  onTimeout,
}: CreateTerminalReplaySemaphoreOptions = {}): TerminalReplaySemaphore {
  const maxActive = Math.max(1, Math.floor(concurrency));
  let active = 0;
  let seq = 0;
  const pending: QueueItem[] = [];

  const takeNext = (): QueueItem | undefined => {
    if (pending.length === 0) return undefined;
    let bestIndex = 0;
    for (let i = 1; i < pending.length; i += 1) {
      const a = pending[i];
      const b = pending[bestIndex];
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) bestIndex = i;
    }
    return pending.splice(bestIndex, 1)[0];
  };

  let generation = 0;

  /** 占一个槽跑任务；返回任务自身的 promise（不额外包一层，无竞争路径零额外微任务跳数）。 */
  const occupy = <T,>(run: () => Promise<T>, label: string | undefined): Promise<T> => {
    const myGeneration = generation;
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (myGeneration !== generation) return;
      active -= 1;
      drain();
    };
    const startedAt = Date.now();
    // 超时只释放槽位：任务继续跑、结果照常交付，别让一个卡住的 snapshot 拖死后面所有标签。
    const timer = setTimeout(() => {
      onTimeout?.(label, Date.now() - startedAt);
      release();
    }, timeoutMs);
    let result: Promise<T>;
    try {
      result = run();
    } catch (error) {
      result = Promise.reject(error);
    }
    const settle = () => {
      clearTimeout(timer);
      release();
    };
    result.then(settle, settle);
    return result;
  };

  const drain = () => {
    while (active < maxActive) {
      const item = takeNext();
      if (!item) return;
      if (item.isCancelled?.()) {
        item.reject(createTerminalReplayCancelledError());
        continue;
      }
      occupy(item.run, item.label).then(item.resolve, item.reject);
    }
  };

  return {
    run<T>(task: () => Promise<T>, options: TerminalReplayRunOptions = {}): Promise<T> {
      if (options.isCancelled?.()) return Promise.reject(createTerminalReplayCancelledError());
      // 无竞争快路径：直接占槽起跑，返回任务自身的 promise。
      if (active < maxActive && pending.length === 0) return occupy(task, options.label);
      return new Promise<T>((resolve, reject) => {
        pending.push({
          run: task,
          resolve: resolve as (value: unknown) => void,
          reject,
          priority: options.priority ?? TERMINAL_REPLAY_PRIORITY_BACKGROUND,
          seq: ++seq,
          isCancelled: options.isCancelled,
          label: options.label,
        });
        drain();
      });
    },
    getSnapshot: () => ({ active, pending: pending.length }),
    _resetForTest(): void {
      generation += 1;
      active = 0;
      pending.length = 0;
    },
  };
}

/** 前台判据与 WebGL 预算一致：元素有布局盒即视为可见。 */
export function terminalReplayPriority(
  term: { element?: HTMLElement | null } | null | undefined,
): number {
  const visible = Boolean(term?.element?.getClientRects?.().length);
  return visible ? TERMINAL_REPLAY_PRIORITY_FOREGROUND : TERMINAL_REPLAY_PRIORITY_BACKGROUND;
}

/** 全 WebView 单例。 */
export const terminalReplaySemaphore = createTerminalReplaySemaphore({
  onTimeout: (label, elapsedMs) => {
    console.warn(`[terminal-diag] replay slot released after ${elapsedMs}ms timeout`, { label });
  },
});

/** 四个重放入口的统一包装：优先级按终端可见性即时判定。 */
export function runTerminalReplay<T>(
  term: { element?: HTMLElement | null } | null | undefined,
  task: () => Promise<T>,
  options: Omit<TerminalReplayRunOptions, "priority"> = {},
): Promise<T> {
  return terminalReplaySemaphore.run(task, { ...options, priority: terminalReplayPriority(term) });
}
