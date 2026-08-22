import { describe, expect, it, vi } from "vitest";
import {
  deliverTerminalDataWithDeferredCredit,
  takeCurrentTerminalDeliveryCredit,
} from "./terminalDeliveryCredit";

describe("terminalDeliveryCredit", () => {
  it("无人认领时在 deliver 返回处自动归还", () => {
    const complete = vi.fn();
    deliverTerminalDataWithDeferredCredit(complete, () => {});
    // 消费者整段丢弃且没认领，信用也不能漏——漏一次就永久缩小上游窗口
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("有人认领时推迟到认领方归还之后", () => {
    const complete = vi.fn();
    let release: (() => void) | null = null;

    deliverTerminalDataWithDeferredCredit(complete, () => {
      release = takeCurrentTerminalDeliveryCredit();
    });
    expect(complete).not.toHaveBeenCalled();

    release!();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("等最慢的认领方（多视图：主标签 + 星标镜像）", () => {
    const complete = vi.fn();
    const releases: Array<() => void> = [];

    deliverTerminalDataWithDeferredCredit(complete, () => {
      releases.push(takeCurrentTerminalDeliveryCredit()!);
      releases.push(takeCurrentTerminalDeliveryCredit()!);
    });

    releases[0]();
    // 只按最快的那个回执会低报背压，慢视图的积压对上游隐形
    expect(complete).not.toHaveBeenCalled();
    releases[1]();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("归还函数幂等（重复调用安全，鼓励宁可多调）", () => {
    const complete = vi.fn();
    let release: (() => void) | null = null;
    deliverTerminalDataWithDeferredCredit(complete, () => {
      release = takeCurrentTerminalDeliveryCredit();
    });

    release!();
    release!();
    release!();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("嵌套分发后恢复外层，外层的后续认领不会挂错账", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    let outerRelease: (() => void) | null = null;

    deliverTerminalDataWithDeferredCredit(outer, () => {
      deliverTerminalDataWithDeferredCredit(inner, () => {
        takeCurrentTerminalDeliveryCredit()!(); // 内层认领并立即归还
      });
      expect(inner).toHaveBeenCalledTimes(1);
      // 内层返回后当前信用必须已恢复成外层
      outerRelease = takeCurrentTerminalDeliveryCredit();
    });

    expect(outer).not.toHaveBeenCalled();
    outerRelease!();
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("分发窗口之外认领返回 null（调用方无需归还）", () => {
    expect(takeCurrentTerminalDeliveryCredit()).toBeNull();

    let escaped: (() => void) | null = null;
    deliverTerminalDataWithDeferredCredit(vi.fn(), () => {
      escaped = takeCurrentTerminalDeliveryCredit();
    });
    expect(escaped).not.toBeNull();
    // deliver 已返回，窗口关闭
    expect(takeCurrentTerminalDeliveryCredit()).toBeNull();
  });

  it("deliver 抛错也归还信用（否则一次渲染异常 = 永久债务）", () => {
    const complete = vi.fn();
    expect(() =>
      deliverTerminalDataWithDeferredCredit(complete, () => {
        throw new Error("render blew up");
      }),
    ).toThrow("render blew up");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
