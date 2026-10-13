import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_REPLAY_PRIORITY_BACKGROUND,
  TERMINAL_REPLAY_PRIORITY_FOREGROUND,
  TERMINAL_REPLAY_TIMEOUT_MS,
  createTerminalReplaySemaphore,
  isTerminalReplayCancelled,
  terminalReplayPriority,
} from "./terminalReplaySemaphore";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };

describe("createTerminalReplaySemaphore", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("并发 1：后一个任务等前一个结束才启动，FIFO", async () => {
    const sem = createTerminalReplaySemaphore();
    const started: string[] = [];
    const a = deferred(); const b = deferred();
    const pa = sem.run(() => { started.push("a"); return a.promise; });
    const pb = sem.run(() => { started.push("b"); return b.promise; });
    await flush();
    expect(started).toEqual(["a"]);
    expect(sem.getSnapshot()).toEqual({ active: 1, pending: 1 });
    a.resolve();
    await flush();
    expect(started).toEqual(["a", "b"]);
    b.resolve();
    await Promise.all([pa, pb]);
    expect(sem.getSnapshot()).toEqual({ active: 0, pending: 0 });
  });

  it("前台（优先级 0）插队到所有后台任务之前", async () => {
    const sem = createTerminalReplaySemaphore();
    const started: string[] = [];
    const gate = deferred();
    void sem.run(() => { started.push("running"); return gate.promise; });
    void sem.run(async () => { started.push("bg1"); }, { priority: TERMINAL_REPLAY_PRIORITY_BACKGROUND });
    void sem.run(async () => { started.push("bg2"); }, { priority: TERMINAL_REPLAY_PRIORITY_BACKGROUND });
    void sem.run(async () => { started.push("fg"); }, { priority: TERMINAL_REPLAY_PRIORITY_FOREGROUND });
    await flush();
    expect(started).toEqual(["running"]);
    gate.resolve();
    await flush();
    expect(started).toEqual(["running", "fg", "bg1", "bg2"]);
  });

  it("30 s 超时释放槽位但任务结果照常交付", async () => {
    const onTimeout = vi.fn();
    const sem = createTerminalReplaySemaphore({ onTimeout });
    const started: string[] = [];
    const stuck = deferred<string>();
    const pStuck = sem.run(() => { started.push("stuck"); return stuck.promise; }, { label: "stuck" });
    void sem.run(async () => { started.push("next"); });
    await flush();
    expect(started).toEqual(["stuck"]);
    vi.advanceTimersByTime(TERMINAL_REPLAY_TIMEOUT_MS);
    await flush();
    expect(onTimeout).toHaveBeenCalledWith("stuck", expect.any(Number));
    expect(started).toEqual(["stuck", "next"]);
    stuck.resolve("late");
    await expect(pStuck).resolves.toBe("late");
    // 超时后再 settle 不得二次释放（active 不为负）
    expect(sem.getSnapshot()).toEqual({ active: 0, pending: 0 });
  });

  it("排队期间取消：出队即拒绝且不占槽；入队时已取消立即拒绝", async () => {
    const sem = createTerminalReplaySemaphore();
    const gate = deferred();
    let cancelled = false;
    void sem.run(() => gate.promise);
    const task = vi.fn(async () => "ran");
    const pCancelled = sem.run(task, { isCancelled: () => cancelled });
    const pAfter = sem.run(async () => "after");
    cancelled = true;
    gate.resolve();
    await expect(pCancelled).rejects.toSatisfy(isTerminalReplayCancelled);
    expect(task).not.toHaveBeenCalled();
    await expect(pAfter).resolves.toBe("after");

    await expect(sem.run(task, { isCancelled: () => true })).rejects.toSatisfy(isTerminalReplayCancelled);
    expect(task).not.toHaveBeenCalled();
  });

  it("任务抛错 / 同步抛错都释放槽位并把错误交给调用方", async () => {
    const sem = createTerminalReplaySemaphore();
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(sem.run(() => { throw new Error("sync"); })).rejects.toThrow("sync");
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
    expect(sem.getSnapshot()).toEqual({ active: 0, pending: 0 });
  });

  it("terminalReplayPriority：有布局盒为前台，否则后台", () => {
    const visible = { element: { getClientRects: () => [{}] } as unknown as HTMLElement };
    const hidden = { element: { getClientRects: () => [] } as unknown as HTMLElement };
    expect(terminalReplayPriority(visible)).toBe(TERMINAL_REPLAY_PRIORITY_FOREGROUND);
    expect(terminalReplayPriority(hidden)).toBe(TERMINAL_REPLAY_PRIORITY_BACKGROUND);
    expect(terminalReplayPriority({ element: null })).toBe(TERMINAL_REPLAY_PRIORITY_BACKGROUND);
    expect(terminalReplayPriority(null)).toBe(TERMINAL_REPLAY_PRIORITY_BACKGROUND);
  });
});
