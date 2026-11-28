import { beforeEach, describe, expect, it } from "vitest";
import { usePanesStore } from "@/stores/usePanesStore";
import { useResumeBindingStore } from "@/stores/useResumeBindingStore";
import { createPanel } from "@/lib/paneTree";
import type { Tab, TerminalPaneLeaf } from "@/types";
import { recoverFromDeadResume, resetDeadResumeRecoveryForTest } from "./deadResumeRecovery";

const DEAD = "4b27b0d6-9fbf-40df-b000-9daa1cb9842e";

function seed(sessionId: string, resumeId: string | undefined = DEAD) {
  const leaf: TerminalPaneLeaf = { type: "leaf", id: "leaf-1", sessionId, resumeId };
  const tab: Tab = {
    id: "tab-1",
    title: "cc-pane",
    contentType: "terminal",
    projectId: "p",
    projectPath: "/tmp/p",
    sessionId,
    resumeId,
    cliTool: "claude",
    terminalRootPane: leaf,
    activeTerminalPaneId: leaf.id,
  };
  const rootPane = createPanel(tab);
  usePanesStore.setState({
    rootPane,
    activePaneId: rootPane.id,
    layouts: [{ id: "layout-1", name: "布局 1", kind: "normal", rootPane, activePaneId: rootPane.id }],
    currentLayoutId: "layout-1",
  });
}

function leaf(): TerminalPaneLeaf {
  const tab = usePanesStore.getState().findTabAcrossLayouts("tab-1")?.tab;
  if (!tab?.terminalRootPane || tab.terminalRootPane.type !== "leaf") throw new Error("leaf missing");
  return tab.terminalRootPane;
}

describe("recoverFromDeadResume", () => {
  beforeEach(() => {
    resetDeadResumeRecoveryForTest();
    useResumeBindingStore.setState({ bindings: {}, tombstones: {} });
  });

  it("撤掉死 id 并原位自动新建一次（不带 resume）", () => {
    seed("pty-dead");
    useResumeBindingStore.getState().recordBinding("pty-dead", DEAD, "issued");

    expect(recoverFromDeadResume("pty-dead", DEAD)).toBe("relaunched");

    const after = leaf();
    expect(after.resumeId).toBeUndefined();
    expect(after.sessionId).toBeNull();
    expect(after.restoring).toBe(true);
    expect(after.launchAttempt).toBe(1);
    expect(after.launchError).toBeUndefined();
    expect(useResumeBindingStore.getState().getBinding("pty-dead")).toBeUndefined();
    // 墓碑：本次运行内迟到的同 id 绑定被拒。
    expect(useResumeBindingStore.getState().recordBinding("pty-dead", DEAD, "issued")).toBe(false);
  });

  it("同一 leaf 本周期再次命中时停下来给错误面板，不再自动新建", () => {
    seed("pty-dead");
    expect(recoverFromDeadResume("pty-dead", DEAD)).toBe("relaunched");

    // 新建的会话（假设迟到绑定又把死 id 写回）再次报目标缺失。
    seed("pty-second");
    expect(recoverFromDeadResume("pty-second", DEAD)).toBe("stopped");

    const after = leaf();
    expect(after.launchError?.message).toBeTruthy();
    expect(after.launchAttempt).toBeUndefined();
    expect(after.sessionId).toBeNull();
  });

  it("leaf 已换成别的 resume id 时什么都不动", () => {
    seed("pty-dead", "resume-newer");
    useResumeBindingStore.getState().recordBinding("pty-dead", "resume-newer", "manual");

    expect(recoverFromDeadResume("pty-dead", DEAD)).toBe("not-found");
    expect(leaf().resumeId).toBe("resume-newer");
    expect(leaf().sessionId).toBe("pty-dead");
    expect(useResumeBindingStore.getState().getBinding("pty-dead")?.resumeId).toBe("resume-newer");
  });
});
