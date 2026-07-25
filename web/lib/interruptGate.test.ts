import { describe, expect, it } from "vitest";
import {
  checkInterruptGate,
  type InterruptGateDeps,
  type InterruptKind,
} from "./interruptGate";

const APP_STARTED_AT = 1_000;

function createDeps(overrides: Partial<InterruptGateDeps> = {}): InterruptGateDeps {
  return {
    now: () => APP_STARTED_AT + 30_000,
    appStartedAt: APP_STARTED_AT,
    sessionStatuses: ["idle"],
    hasOpenDialog: false,
    isMiniMode: false,
    isFullscreen: false,
    activeInterrupt: null,
    ...overrides,
  };
}

function check(kind: InterruptKind, overrides: Partial<InterruptGateDeps> = {}) {
  return checkInterruptGate(kind, createDeps(overrides));
}

describe("checkInterruptGate", () => {
  it.each(["active", "thinking", "toolRunning", "compacting"] as const)(
    "用既有忙碌判定拦截 %s",
    (status) => {
      expect(check("update", { sessionStatuses: ["idle", status] })).toBe("agentBusy");
    },
  );

  it("额外把 waitingInput 视为不可打扰", () => {
    expect(check("tip", { sessionStatuses: ["waitingInput"] })).toBe("agentBusy");
  });

  it("启动未满 30 秒时拦截", () => {
    expect(check("update", { now: () => APP_STARTED_AT + 29_999 })).toBe("startupGrace");
  });

  it("有对话框打开时拦截", () => {
    expect(check("update", { hasOpenDialog: true })).toBe("dialogOpen");
  });

  it("迷你模式时拦截", () => {
    expect(check("update", { isMiniMode: true })).toBe("miniMode");
  });

  it("全屏时拦截", () => {
    expect(check("tip", { isFullscreen: true })).toBe("fullscreen");
  });

  it("功能提示不能顶掉更新提示", () => {
    expect(check("tip", { activeInterrupt: "update" })).toBe("occupied");
  });

  it("更新提示可以顶掉功能提示", () => {
    expect(check("update", { activeInterrupt: "tip" })).toBeNull();
  });

  it("同类打扰不能重复出现", () => {
    expect(check("update", { activeInterrupt: "update" })).toBe("occupied");
  });

  it("所有条件满足时放行", () => {
    expect(check("tip")).toBeNull();
  });

  it("返回首个命中的拒绝原因", () => {
    expect(
      check("tip", {
        sessionStatuses: ["thinking"],
        now: () => APP_STARTED_AT,
        hasOpenDialog: true,
        activeInterrupt: "update",
      }),
    ).toBe("agentBusy");
  });
});
