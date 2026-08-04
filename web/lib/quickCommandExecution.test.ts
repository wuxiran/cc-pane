import { describe, expect, it, vi } from "vitest";
import type { QuickCommand, Tab } from "@/types";
import {
  buildQuickCommandTerminalTab,
  executeQuickCommand,
  getQuickCommandSessionId,
  type QuickCommandExecutionAdapter,
} from "./quickCommandExecution";

function command(overrides: Partial<QuickCommand> = {}): QuickCommand {
  return {
    id: "quick-1",
    name: "Run tests",
    kind: "terminal",
    text: "cargo test",
    appendEnter: true,
    target: "currentPane",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

function splitTab(): Tab {
  return {
    id: "tab-1",
    title: "repo",
    contentType: "terminal",
    projectId: "project-1",
    projectPath: "/repo",
    sessionId: "stale-tab-session",
    activeTerminalPaneId: "leaf-b",
    terminalRootPane: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "leaf", id: "leaf-a", sessionId: "session-a" },
        { type: "leaf", id: "leaf-b", sessionId: "session-b" },
      ],
    },
  };
}

function adapter(): QuickCommandExecutionAdapter {
  return {
    submit: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    launchAgent: vi.fn(async () => undefined),
    launchTerminal: vi.fn(async () => "new-session"),
  };
}

describe("quickCommandExecution", () => {
  it("split tab 使用 activeTerminalPaneId 对应 leaf session", () => {
    expect(getQuickCommandSessionId(splitTab())).toBe("session-b");
  });

  it("appendEnter=true 使用 submitToSession", async () => {
    const target = adapter();

    await executeQuickCommand(command(), { paneId: "pane-1", tab: splitTab() }, target);

    expect(target.submit).toHaveBeenCalledWith("session-b", "cargo test");
    expect(target.write).not.toHaveBeenCalled();
  });

  it("appendEnter=false 使用 system source write", async () => {
    const target = adapter();

    await executeQuickCommand(
      command({ appendEnter: false }),
      { paneId: "pane-1", tab: splitTab() },
      target,
    );

    expect(target.write).toHaveBeenCalledWith(
      "session-b",
      "cargo test",
      { source: "system" },
    );
  });

  it("agentPrompt 新 tab 走 pending launch 适配器", async () => {
    const target = adapter();
    const prompt = command({
      kind: "agentPrompt",
      target: "newTab",
      cliTool: "codex",
      text: "Review this repo",
    });

    await executeQuickCommand(prompt, { paneId: "pane-1", tab: splitTab() }, target);

    expect(target.launchAgent).toHaveBeenCalledWith(prompt, {
      paneId: "pane-1",
      tab: splitTab(),
    });
    expect(target.launchTerminal).not.toHaveBeenCalled();
  });

  it("terminal 新 tab 等 session 后按 appendEnter 分发", async () => {
    const target = adapter();
    const quick = command({ target: "newTab", appendEnter: false });

    await executeQuickCommand(quick, { paneId: "pane-1", tab: splitTab() }, target);

    expect(target.launchTerminal).toHaveBeenCalledWith(quick, {
      paneId: "pane-1",
      tab: splitTab(),
    });
    expect(target.write).toHaveBeenCalledWith(
      "new-session",
      "cargo test",
      { source: "system" },
    );
  });

  it("terminal 新 tab 强制 Native，不复制来源 tab 的显式 Provider", () => {
    const tab = {
      ...splitTab(),
      providerId: "provider-1",
      providerSelection: "explicit" as const,
    };

    expect(buildQuickCommandTerminalTab(command(), tab)).toMatchObject({
      cliTool: "none",
      providerId: undefined,
      providerSelection: "none",
    });
  });

  it("同 session 连投严格串行", async () => {
    let releaseFirst: (() => void) | undefined;
    const target = adapter();
    vi.mocked(target.submit)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }))
      .mockResolvedValueOnce(undefined);

    const first = executeQuickCommand(command(), { paneId: "pane-1", tab: splitTab() }, target);
    const second = executeQuickCommand(command(), { paneId: "pane-1", tab: splitTab() }, target);
    await vi.waitFor(() => expect(target.submit).toHaveBeenCalledTimes(1));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(target.submit).toHaveBeenCalledTimes(2);
  });
});
