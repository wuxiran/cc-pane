// 启动恢复闸门直测（0.12.0 发版闸门 QA）。
//
// 这是全渲染进程唯一的终端创建排序点：所有 createSession 路径都在它后面排队，
// 等 reconcileTerminalSessions 先把活会话认领回去。两种坏法都不会报错——
// 「该等的没等」= 恢复期重建一堆重复 PTY；「该放的没放」= 所有终端永久转圈。
// 此前只有 terminalService.test.ts 借道用它做过一次排序断言，本体零直测。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetTerminalRestoreBarrierForTest,
  beginTerminalRestoreBarrier,
  finishTerminalRestoreBarrier,
  waitForTerminalRestoreBarrier,
  waitForTerminalRestoreBarrierWithDeadline,
} from "./terminalRestoreBarrier";
import { TERMINAL_LAUNCH_TIMEOUT_MS } from "./terminalLaunchDeadline";

/** 探测 promise 是否已 settle，而不去 await 一个可能永不 resolve 的东西。 */
function settleProbe(promise: Promise<unknown>): { settled: () => boolean } {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { settled: () => done };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

beforeEach(() => {
  _resetTerminalRestoreBarrierForTest();
});

afterEach(() => {
  _resetTerminalRestoreBarrierForTest();
  vi.useRealTimers();
});

describe("terminalRestoreBarrier", () => {
  it("未 begin 时立即 resolve（无恢复轮的场景不得把终端创建挂住）", async () => {
    const probe = settleProbe(waitForTerminalRestoreBarrier());
    await flush();
    expect(probe.settled()).toBe(true);
  });

  it("begin 之后、finish 之前保持挂起", async () => {
    beginTerminalRestoreBarrier();
    const probe = settleProbe(waitForTerminalRestoreBarrier());
    await flush();
    expect(probe.settled()).toBe(false);
  });

  it("finish 后等待方 resolve", async () => {
    beginTerminalRestoreBarrier();
    const waiter = waitForTerminalRestoreBarrier();
    const probe = settleProbe(waiter);

    finishTerminalRestoreBarrier();
    await flush();

    expect(probe.settled()).toBe(true);
    await expect(waiter).resolves.toBeUndefined();
  });

  it("finish 之后新来的等待方也立即 resolve（迟到者不会被已完成的闸门挡住）", async () => {
    beginTerminalRestoreBarrier();
    finishTerminalRestoreBarrier();

    const probe = settleProbe(waitForTerminalRestoreBarrier());
    await flush();
    expect(probe.settled()).toBe(true);
  });

  it("begin 幂等：重复 begin 返回同一个 promise，不会换掉正在被等的那个", async () => {
    const first = beginTerminalRestoreBarrier();
    const second = beginTerminalRestoreBarrier();
    expect(second).toBe(first);

    const probe = settleProbe(waitForTerminalRestoreBarrier());
    await flush();
    expect(probe.settled()).toBe(false);

    // 一次 finish 即可放行——若第二次 begin 换了 promise，这里会永远挂住
    finishTerminalRestoreBarrier();
    await flush();
    expect(probe.settled()).toBe(true);
  });

  it("finish 幂等：重复 finish 不抛（多个收尾路径可能各调一次）", () => {
    beginTerminalRestoreBarrier();
    finishTerminalRestoreBarrier();
    expect(() => finishTerminalRestoreBarrier()).not.toThrow();
  });

  it("未 begin 直接 finish 不抛", () => {
    expect(() => finishTerminalRestoreBarrier()).not.toThrow();
  });

  it("begin→finish→begin：第二轮闸门重新生效（不被上一轮的 resolve 污染）", async () => {
    beginTerminalRestoreBarrier();
    finishTerminalRestoreBarrier();

    // 注意：不 reset 的话 startupBarrier 仍是上一轮那个已 resolve 的 promise，
    // 第二次 begin 会直接返回它——「一次性闸门」是当前实现的既定语义，
    // 这条把该语义钉住，免得后来者以为它可以重入。
    beginTerminalRestoreBarrier();
    const probe = settleProbe(waitForTerminalRestoreBarrier());
    await flush();
    expect(probe.settled()).toBe(true);
  });

  it("withDeadline：闸门先完成时正常 resolve，不受超时影响", async () => {
    vi.useFakeTimers();
    beginTerminalRestoreBarrier();
    const waiter = waitForTerminalRestoreBarrierWithDeadline();
    const probe = settleProbe(waiter);

    finishTerminalRestoreBarrier();
    await flush();

    expect(probe.settled()).toBe(true);
    await expect(waiter).resolves.toBeUndefined();
  });

  it("withDeadline：闸门迟迟不 finish 时到点放行（reject 成 LAUNCH_TIMEOUT，不让终端永久转圈）", async () => {
    vi.useFakeTimers();
    beginTerminalRestoreBarrier();
    const waiter = waitForTerminalRestoreBarrierWithDeadline();
    const rejection = waiter.catch((error) => error);

    await vi.advanceTimersByTimeAsync(TERMINAL_LAUNCH_TIMEOUT_MS + 1);

    await expect(rejection).resolves.toMatchObject({ code: "LAUNCH_TIMEOUT" });
  });

  it("withDeadline：超时前一刻仍挂起（deadline 不是提前放行）", async () => {
    vi.useFakeTimers();
    beginTerminalRestoreBarrier();
    const waiter = waitForTerminalRestoreBarrierWithDeadline();
    const probe = settleProbe(waiter.catch(() => {}));

    await vi.advanceTimersByTimeAsync(TERMINAL_LAUNCH_TIMEOUT_MS - 1);
    expect(probe.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(probe.settled()).toBe(true);
  });

  it("_resetTerminalRestoreBarrierForTest 清干净：reset 后 wait 立即 resolve", async () => {
    beginTerminalRestoreBarrier();
    _resetTerminalRestoreBarrierForTest();

    const probe = settleProbe(waitForTerminalRestoreBarrier());
    await flush();
    expect(probe.settled()).toBe(true);
  });
});
