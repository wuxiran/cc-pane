// 批5 判别联合测试。
//
// 这个函数的价值全在**优先级顺序**上——7 个字段可以任意组合，顺序写错会让
// 用户看到「正在恢复」的死会话、或者一个永远转圈的假恢复。所以测的重点是
// 冲突组合，不是单字段。
import { describe, it, expect } from "vitest";
import {
  isInteractivePhase,
  isLivePhase,
  isPendingPhase,
  needsUserActionPhase,
  phaseOf,
  type TerminalRuntimePhase,
} from "./terminalRuntimePhase";

describe("单字段基本判定", () => {
  it("什么都没有 → idle", () => {
    expect(phaseOf({})).toBe("idle");
  });

  it("有 sessionId → running", () => {
    expect(phaseOf({ sessionId: "s1" })).toBe("running");
  });

  it("restoring 标志 → restoring", () => {
    expect(phaseOf({ restoring: true })).toBe("restoring");
  });

  it("有 savedSessionId 但没 attach 上 → restoring（标志可能还没置位）", () => {
    expect(phaseOf({ savedSessionId: "s-old" })).toBe("restoring");
  });

  it("exitCode 存在 → exited（含 0）", () => {
    expect(phaseOf({ exitCode: 0 })).toBe("exited");
    expect(phaseOf({ exitCode: 1 })).toBe("exited");
  });

  it("disconnected → disconnected", () => {
    expect(phaseOf({ disconnected: true })).toBe("disconnected");
  });

  it("重试中（attempt>0 无 error 无 session）→ launching，不是 launch-failed", () => {
    expect(phaseOf({ launchAttempt: 1 })).toBe("launching");
  });

  it("重试又失败（attempt>0 且有 error）→ launch-failed", () => {
    expect(phaseOf({ launchAttempt: 1, launchError: { message: "x" } })).toBe("launch-failed");
  });
});

describe("冲突组合的优先级（顺序本身就是规格）", () => {
  it("**已退出压倒一切**：别的字段再热闹也是 exited", () => {
    expect(
      phaseOf({
        exitCode: 0,
        sessionId: "s1",
        restoring: true,
        disconnected: true,
      }),
    ).toBe("exited");
  });

  it("启动失败压过恢复中：用户需要看到错误而不是转圈", () => {
    expect(phaseOf({ launchError: { message: "boom" }, restoring: true })).toBe("launch-failed");
  });

  it("**被挡住的恢复压过恢复中**：否则显示一个永远转圈的假恢复", () => {
    expect(
      phaseOf({ restoreBlockedReason: "lease-held", restoring: true, savedSessionId: "s1" }),
    ).toBe("restore-blocked");
  });

  it("恢复中压过断连：恢复本身就在处理连接问题", () => {
    expect(phaseOf({ restoring: true, disconnected: true })).toBe("restoring");
  });

  it("断连压过运行中：有会话但连不上不算正常运行", () => {
    expect(phaseOf({ sessionId: "s1", disconnected: true })).toBe("disconnected");
  });

  it("attach 成功后 savedSessionId 不再意味着恢复中", () => {
    expect(phaseOf({ savedSessionId: "s-old", sessionId: "s-new" })).toBe("running");
  });
});

describe("派生判据", () => {
  const allPhases: TerminalRuntimePhase[] = [
    "idle", "launching", "launch-failed", "restoring",
    "restore-blocked", "running", "disconnected", "exited",
  ];

  it("只有 running 可交互", () => {
    for (const p of allPhases) {
      expect(isInteractivePhase(p)).toBe(p === "running");
    }
  });

  it("只读租约下即使 running 也不可交互", () => {
    expect(isInteractivePhase("running", true)).toBe(false);
  });

  it("加载态只有 launching / restoring", () => {
    expect(allPhases.filter(isPendingPhase)).toEqual(["launching", "restoring"]);
  });

  it("需要用户处置的只有两个错误态", () => {
    expect(allPhases.filter(needsUserActionPhase)).toEqual(["launch-failed", "restore-blocked"]);
  });

  it("**存活判据决定关闭时要不要回收 PTY**：restoring 也算活的（会话已建）", () => {
    expect(allPhases.filter(isLivePhase)).toEqual(["restoring", "running", "disconnected"]);
  });
});
