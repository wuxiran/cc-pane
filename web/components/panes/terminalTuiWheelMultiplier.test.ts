import { beforeEach, describe, expect, it } from "vitest";

import { attachTerminalTuiWheelMultiplier } from "./terminalTuiWheelMultiplier";

type MouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";

/**
 * 最小 xterm 替身：只提供 attach 模块真正用到的四样东西。
 * 关键是 `element` 要是真 DOM——补发的克隆事件靠 `dispatchEvent` 走真实事件流。
 */
function createFakeTerminal(mouseTrackingMode: MouseTrackingMode = "any") {
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  element.appendChild(screen);
  document.body.appendChild(element);
  if (mouseTrackingMode !== "none") element.classList.add("enable-mouse-events");

  let handler: ((event: WheelEvent) => boolean) | null = null;
  const dispatched: WheelEvent[] = [];
  let lastHandlerResult = true;

  // 复刻 xterm 的形态：滚轮监听挂在 element 上，先问自定义 handler。
  // handler 只在这里调用一次——多调一次会让报告重复入队，测出来的数字就假了。
  element.addEventListener("wheel", (event) => {
    const wheel = event as WheelEvent;
    dispatched.push(wheel);
    lastHandlerResult = handler ? handler(wheel) : true;
  });

  return {
    element,
    rows: 24,
    modes: { mouseTrackingMode },
    attachCustomWheelEventHandler: (fn: (event: WheelEvent) => boolean) => {
      handler = fn;
    },
    /**
     * 走真实事件流，便于验证补发是否会递归。返回 handler 对**原事件**的裁决。
     *
     * `wheelDeltaY` 必须手动挂：真实浏览器的滚轮事件带这个传统字段，
     * 而 jsdom 合成的不带——不补上的话距离模型会把它当成触控板连续流
     * （走 1:1 路径、倍率不参与），测出来的就不是滚轮该有的行为。
     */
    fireWheel(init: WheelEventInit & { wheelDeltaY?: number }) {
      const { wheelDeltaY, ...eventInit } = init;
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ...eventInit,
      });
      if (wheelDeltaY !== undefined) {
        Object.defineProperty(event, "wheelDeltaY", { configurable: true, value: wheelDeltaY });
      }
      element.dispatchEvent(event);
      return lastHandlerResult;
    },
    get dispatchedCount() {
      return dispatched.length;
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

describe("attachTerminalTuiWheelMultiplier", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("应用没开鼠标上报时完全不介入，交回 xterm 原生处理", () => {
    const term = createFakeTerminal("none");
    attachTerminalTuiWheelMultiplier(term);

    const before = term.dispatchedCount;
    const proceed = term.fireWheel({ deltaY: 120 });

    expect(proceed).toBe(true);
    // 没有补发任何克隆事件
    expect(term.dispatchedCount).toBe(before + 1);
  });

  it("Shift 是终端惯例的绕过手势，不能被放大", () => {
    const term = createFakeTerminal("any");
    attachTerminalTuiWheelMultiplier(term);

    const proceed = term.fireWheel({ deltaY: 120, shiftKey: true });
    expect(proceed).toBe(true);
  });

  it("开了鼠标上报时接管原事件并补发克隆报告", async () => {
    const term = createFakeTerminal("any");
    attachTerminalTuiWheelMultiplier(term);

    const before = term.dispatchedCount;
    const proceed = term.fireWheel({ deltaY: 120, deltaMode: 0 });
    // 原事件不再由 xterm 发报告
    expect(proceed).toBe(false);

    await flushMicrotasks();
    // 至少补发了一个克隆
    expect(term.dispatchedCount).toBeGreaterThan(before + 1);
  });

  it("补发的事件不会再次进入放大路径（防无限递归）", async () => {
    const term = createFakeTerminal("any");
    attachTerminalTuiWheelMultiplier(term);

    term.fireWheel({ deltaY: 120, deltaMode: 0 });
    await flushMicrotasks();
    const afterFirstDrain = term.dispatchedCount;

    // 再排空几轮：若克隆会递归放大，事件数会持续膨胀
    await flushMicrotasks();
    await flushMicrotasks();
    expect(term.dispatchedCount).toBe(afterFirstDrain);
  });

  it("排空前应用关掉了鼠标上报就丢弃待发报告，避免平白多滚", async () => {
    const term = createFakeTerminal("any");
    attachTerminalTuiWheelMultiplier(term);

    term.fireWheel({ deltaY: 120, deltaMode: 0 });
    const before = term.dispatchedCount;
    // TUI 退出/切界面：鼠标上报关掉
    term.modes.mouseTrackingMode = "none";

    await flushMicrotasks();
    expect(term.dispatchedCount).toBe(before);
  });

  it("缺少 attachCustomWheelEventHandler 的旧版/替身直接不启用，不抛", () => {
    const bare = {
      element: document.createElement("div"),
      rows: 24,
      modes: { mouseTrackingMode: "any" as MouseTrackingMode },
    } as unknown as Parameters<typeof attachTerminalTuiWheelMultiplier>[0];

    expect(() => attachTerminalTuiWheelMultiplier(bare)).not.toThrow();
  });

  it("倍率经注入口生效", async () => {
    const plain = createFakeTerminal("any");
    attachTerminalTuiWheelMultiplier(plain);
    const plainBefore = plain.dispatchedCount;
    plain.fireWheel({ deltaY: 120, deltaMode: 0, wheelDeltaY: -120 });
    await flushMicrotasks();
    const plainReports = plain.dispatchedCount - plainBefore - 1;

    const boosted = createFakeTerminal("any");
    attachTerminalTuiWheelMultiplier(boosted, { getMultiplier: () => 5 });
    const boostedBefore = boosted.dispatchedCount;
    boosted.fireWheel({ deltaY: 120, deltaMode: 0, wheelDeltaY: -120 });
    await flushMicrotasks();
    const boostedReports = boosted.dispatchedCount - boostedBefore - 1;

    expect(boostedReports).toBeGreaterThan(plainReports);
  });
});
