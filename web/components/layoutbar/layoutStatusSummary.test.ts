import { describe, expect, it } from "vitest";
import { createPanel } from "@/stores/paneTreeHelpers";
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
    });
  });

  it("idle/exited/initializing 与无状态会话不计入任何桶", () => {
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
    });
  });
});
