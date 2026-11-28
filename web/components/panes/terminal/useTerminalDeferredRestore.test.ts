import { describe, expect, it } from "vitest";
import { needsActivationRestore } from "./useTerminalDeferredRestore";

// 截图回归：一次普通恢复里「标签切到前台，检查是否需要补做恢复」连刷 3 条，且全是
// needsDeferredRestore=false——init 路径自己在恢复的前台标签每次 effect 重跑都记一条。
// 现在只有真要补做时才进恢复日志，判据本身保持不变。
describe("needsActivationRestore", () => {
  const base = {
    layoutActive: true,
    hasSession: false,
    launchStarted: false,
    deferred: false,
    everHidden: false,
    restoring: true,
  };

  it("is false for a foreground restoring tab the init path owns", () => {
    expect(needsActivationRestore(base)).toBe(false);
    expect(needsActivationRestore({ ...base, launchStarted: true, everHidden: true })).toBe(false);
  });

  it("is true once a hidden-mounted restoring tab comes to the foreground", () => {
    expect(needsActivationRestore({ ...base, everHidden: true })).toBe(true);
    expect(needsActivationRestore({ ...base, deferred: true, restoring: false })).toBe(true);
  });

  it("stays false while hidden or once a session exists", () => {
    expect(needsActivationRestore({ ...base, deferred: true, layoutActive: false })).toBe(false);
    expect(needsActivationRestore({ ...base, deferred: true, hasSession: true })).toBe(false);
    expect(needsActivationRestore({ ...base, everHidden: true, restoring: false })).toBe(false);
  });
});
