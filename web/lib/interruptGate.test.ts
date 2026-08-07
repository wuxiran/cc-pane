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
      expect(check("tip", { sessionStatuses: ["idle", status] })).toBe("agentBusy");
    },
  );

  it("额外把 waitingInput 视为不可打扰", () => {
    expect(check("tip", { sessionStatuses: ["waitingInput"] })).toBe("agentBusy");
  });

  // CC-Panes 几乎总有 busy 会话；update 若一并被挡，卡片不是延后而是永远不出现。
  // 放行的只是「显示」，安装前的忙碌警告走 hasBusySessions()，不受影响。
  describe("agentBusy 对 update 的例外", () => {
    it.each(["active", "thinking", "toolRunning", "compacting", "waitingInput"] as const)(
      "会话 %s 时 update 放行",
      (status) => {
        expect(check("update", { sessionStatuses: ["idle", status] })).toBeNull();
      },
    );

    it("同样条件下 tip 仍被挡", () => {
      expect(check("tip", { sessionStatuses: ["thinking"] })).toBe("agentBusy");
    });

    // 防止「放行过头」：另外四道闸门对 update 一条都不能少。
    it("update 放行 agentBusy 后，启动宽限期仍挡得住", () => {
      expect(
        check("update", { sessionStatuses: ["thinking"], now: () => APP_STARTED_AT }),
      ).toBe("startupGrace");
    });

    it("update 放行 agentBusy 后，对话框仍挡得住", () => {
      expect(check("update", { sessionStatuses: ["thinking"], hasOpenDialog: true })).toBe(
        "dialogOpen",
      );
    });

    it("update 放行 agentBusy 后，迷你模式仍挡得住", () => {
      expect(check("update", { sessionStatuses: ["thinking"], isMiniMode: true })).toBe(
        "miniMode",
      );
    });

    it("update 放行 agentBusy 后，全屏仍挡得住", () => {
      expect(check("update", { sessionStatuses: ["thinking"], isFullscreen: true })).toBe(
        "fullscreen",
      );
    });

    it("update 放行 agentBusy 后，单槽互斥仍生效", () => {
      expect(
        check("update", { sessionStatuses: ["thinking"], activeInterrupt: "update" }),
      ).toBe("occupied");
    });
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

  // notice：普通通知，agent 忙时静默入历史；其余规则与 tip 同，但不占单槽
  describe("notice 规则", () => {
    it("agent 忙时被挡", () => {
      expect(check("notice", { sessionStatuses: ["thinking"] })).toBe("agentBusy");
    });

    it("启动宽限期被挡", () => {
      expect(check("notice", { now: () => APP_STARTED_AT })).toBe("startupGrace");
    });

    it("不参与单槽互斥（update 占槽时照弹）", () => {
      expect(check("notice", { activeInterrupt: "update" })).toBeNull();
    });

    it("迷你模式仍被挡", () => {
      expect(check("notice", { isMiniMode: true })).toBe("miniMode");
    });
  });

  // askInput：agent 等的就是人，弹出本身就是目的
  describe("askInput 规则", () => {
    it.each(["active", "thinking", "toolRunning", "waitingInput"] as const)(
      "会话 %s 时照弹",
      (status) => {
        expect(check("askInput", { sessionStatuses: [status] })).toBeNull();
      },
    );

    it("启动宽限期照弹（恢复期 waiting_input 常见）", () => {
      expect(check("askInput", { now: () => APP_STARTED_AT })).toBeNull();
    });

    it("对话框打开照弹（右下角不遮 dialog）", () => {
      expect(check("askInput", { hasOpenDialog: true })).toBeNull();
    });

    it("全屏照弹", () => {
      expect(check("askInput", { isFullscreen: true })).toBeNull();
    });

    it("迷你模式仍被挡（没地方渲染，OS 通知兜底）", () => {
      expect(check("askInput", { isMiniMode: true })).toBe("miniMode");
    });

    it("不参与单槽互斥", () => {
      expect(check("askInput", { activeInterrupt: "update" })).toBeNull();
    });
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
