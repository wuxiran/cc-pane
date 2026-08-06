import { describe, expect, it } from "vitest";
import { createPanel } from "@/lib/paneTree";
import type { Tab, TerminalStatusInfo } from "@/types";
import { deriveLayoutStatusSummary } from "./layoutStatusSummary";

function terminalTab(id: string, sessionId: string | null = null): Tab {
  return {
    id,
    title: id,
    contentType: "terminal",
    projectId: "project-a",
    projectPath: "/work/cc-book",
    sessionId,
  };
}

function status(sessionId: string, value: TerminalStatusInfo["status"]): TerminalStatusInfo {
  return {
    sessionId,
    status: value,
    lastOutputAt: 1,
    updatedAt: 1,
  };
}

describe("deriveLayoutStatusSummary", () => {
  it("按会话状态分桶计数：error=blocked、waitingInput、干活类=running", () => {
    const rootPane = createPanel();
    rootPane.tabs = [
      terminalTab("tab-1", "s-thinking"),
      terminalTab("tab-2", "s-tool"),
      terminalTab("tab-3", "s-wait"),
      terminalTab("tab-4", "s-error"),
    ];
    const statusMap = new Map([
      ["s-thinking", status("s-thinking", "thinking")],
      ["s-tool", status("s-tool", "toolRunning")],
      ["s-wait", status("s-wait", "waitingInput")],
      ["s-error", status("s-error", "error")],
    ]);

    expect(deriveLayoutStatusSummary(rootPane, statusMap)).toEqual({
      running: 2,
      waitingInput: 1,
      blocked: 1,
      idle: 0,
      total: 4,
    });
  });

  it("idle 计入灰桶, exited/initializing/无状态只计入 total", () => {
    const rootPane = createPanel();
    rootPane.tabs = [
      terminalTab("tab-1", "s-idle"),
      terminalTab("tab-2", "s-exited"),
      terminalTab("tab-3", "s-init"),
      terminalTab("tab-4", "s-unknown"),
      terminalTab("tab-5", null),
    ];
    const statusMap = new Map([
      ["s-idle", status("s-idle", "idle")],
      ["s-exited", status("s-exited", "exited")],
      ["s-init", status("s-init", "initializing")],
    ]);

    expect(deriveLayoutStatusSummary(rootPane, statusMap)).toEqual({
      running: 0,
      waitingInput: 0,
      blocked: 0,
      idle: 1,
      total: 4,
    });
  });

  it("无会话布局 total 为 0", () => {
    expect(deriveLayoutStatusSummary(createPanel(), new Map()).total).toBe(0);
  });

  it("恢复中的 savedSessionId 计入 total（全量口径，与关闭确认弹窗计数一致）", () => {
    const restoringTab = terminalTab("tab-restoring", null);
    restoringTab.restoring = true;
    restoringTab.savedSessionId = "s-saved";
    const liveTab = terminalTab("tab-live", "s-live");
    const rootPane = createPanel();
    rootPane.tabs = [restoringTab, liveTab];
    const statusMap = new Map([["s-live", status("s-live", "thinking")]]);

    expect(deriveLayoutStatusSummary(rootPane, statusMap)).toEqual({
      running: 1,
      waitingInput: 0,
      blocked: 0,
      idle: 0,
      total: 2,
    });
  });

  it("分屏 leaf 的 sessionId 与 savedSessionId 同为一个 id 时不重复计数", () => {
    const tab = terminalTab("tab-split", null);
    tab.terminalRootPane = {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      children: [
        { type: "leaf", id: "leaf-1", sessionId: "s-dup", savedSessionId: "s-dup" },
        { type: "leaf", id: "leaf-2", sessionId: null, savedSessionId: "s-saved" },
      ],
      sizes: [0.5, 0.5],
    };
    const rootPane = createPanel();
    rootPane.tabs = [tab];

    expect(deriveLayoutStatusSummary(rootPane, new Map()).total).toBe(2);
  });
});
