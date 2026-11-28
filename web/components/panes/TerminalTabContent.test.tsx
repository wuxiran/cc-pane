import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Tab, TerminalPaneLeaf } from "@/types";
import { usePanesStore, useTerminalRestoreLogStore } from "@/stores";
import TerminalTabContent from "./TerminalTabContent";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";

const terminalViewMock = vi.hoisted(() => vi.fn());
const coldRestoreMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/coldTerminalRestore", () => ({
  coldRestoreBlockedTerminal: coldRestoreMock,
}));

vi.mock("./TerminalView", () => ({
  default: vi.fn((props: { onRestoreLaunchState?: (state: string) => void }) => {
    terminalViewMock(props);
    return (
    <button
      data-testid="terminal-view"
      onClick={() => props.onRestoreLaunchState?.("queued")}
      onDoubleClick={() => props.onRestoreLaunchState?.("failed")}
    />
    );
  }),
}));

vi.mock("./SplitView", () => ({
  default: ({ children }: { children: React.ReactNode[] }) => <div>{children}</div>,
}));

function createTerminalTab(overrides?: Partial<Tab>): Tab {
  return {
    id: "tab-1",
    title: "project",
    contentType: "terminal",
    projectId: "project-1",
    projectPath: "/tmp/project",
    sessionId: null,
    terminalRootPane: {
      type: "leaf",
      id: "leaf-1",
      sessionId: null,
    },
    activeTerminalPaneId: "leaf-1",
    ...overrides,
  };
}

/** 单 leaf 终端 tab：只覆写 leaf 字段（id/sessionId 有默认值）。 */
function leafTab(leaf: Partial<TerminalPaneLeaf>, tab?: Partial<Tab>): Tab {
  return createTerminalTab({
    ...tab,
    terminalRootPane: { type: "leaf", id: "leaf-1", sessionId: null, ...leaf },
  });
}

function renderTerminalTabContent(
  tab: Tab,
  options?: { visible?: boolean; showStatusBar?: boolean },
) {
  // 可见性走单源：按 tab.id 写 primary 视图条目（默认前台）
  useTabViewStateStore
    .getState()
    .reportView(tab.id, "primary", (options?.visible ?? true) ? "active" : "hidden");
  render(
    <TooltipProvider>
      <TerminalTabContent
        tab={tab}
        layoutActive
        showStatusBar={options?.showStatusBar}
        onSessionCreated={vi.fn()}
        onSessionExited={vi.fn()}
        onTerminalRef={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe("TerminalTabContent", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    useTerminalRestoreLogStore.getState().reset();
    terminalViewMock.mockClear();
    coldRestoreMock.mockReset();
  });

  it.each([
    [{ launchCwd: "/repo-worktrees/task/pkg" }, "/workspace", "/repo-worktrees/task/pkg"],
    [undefined, "/workspace", "/workspace"],
    [undefined, undefined, "/tmp/project"],
  ])("reviews the actual terminal cwd with launch/workspace/project precedence", async (launchExtras, workspacePath, expected) => {
    const openReview = vi.spyOn(usePanesStore.getState(), "openReviewTab").mockReturnValue("review-tab");
    renderTerminalTabContent(
      leafTab({ sessionId: "live-session", launchExtras, workspacePath }),
      { showStatusBar: true },
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("review:title") }));
    expect(openReview).toHaveBeenCalledExactlyOnceWith(expected, {
      paneId: undefined, checkpointChatId: "cli:live-session", cliSessionId: "live-session",
    });
  });

  it("excludes WSL terminals from local repository review even when the host path exists", () => {
    renderTerminalTabContent(
      leafTab({ sessionId: "live-session" }, { wsl: { distro: "Ubuntu", remotePath: "/repo" } }),
      { showStatusBar: true },
    );
    expect(screen.queryByRole("button", { name: i18n.t("review:title") })).not.toBeInTheDocument();
  });

  it.each([true, false])("renders the per-terminal status bar only when showStatusBar=%s", (showStatusBar) => {
    renderTerminalTabContent(
      leafTab({ sessionId: "session-grid", cliTool: "none" }, { sessionId: "session-grid", cliTool: "none" }),
      { showStatusBar },
    );
    expect(screen.queryByTestId("terminal-status-bar") !== null).toBe(showStatusBar);
  });

  it("把 leaf 的 launchId 传给 TerminalView，而不是复用 tab projectId", () => {
    renderTerminalTabContent(
      leafTab({ launchId: "leaf-launch-id" }, { projectId: "stable-tab-project-id" }),
    );

    expect(terminalViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ launchId: "leaf-launch-id" }),
    );
    expect(terminalViewMock.mock.calls[0][0]).not.toHaveProperty("projectId");
  });

  it("shows a persistent launch error with retry and remove actions", () => {
    const retryTerminalLaunch = vi.fn();
    const removeTerminalLaunch = vi.fn();
    usePanesStore.setState({ retryTerminalLaunch, removeTerminalLaunch } as never);
    const launchError = {
      code: "PATH_NOT_FOUND",
      message: "Launch directory does not exist",
      params: { path: "/missing/repo" },
    };
    renderTerminalTabContent(leafTab({ launchError }, { launchError }));

    expect(screen.getByText("终端启动失败")).toBeVisible();
    expect(screen.getByText("路径不存在")).toBeVisible();
    expect(screen.getByText("/missing/repo")).toBeVisible();
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    expect(retryTerminalLaunch).toHaveBeenCalledWith("tab-1", "leaf-1");
    expect(removeTerminalLaunch).toHaveBeenCalledWith("tab-1", "leaf-1");
  });

  it("shows launching overlay for a leaf without a session when a project is already selected", () => {
    renderTerminalTabContent(createTerminalTab());

    expect(screen.getByText("正在启动终端")).toBeVisible();
    expect(screen.getByText("请稍候，正在准备终端会话...")).toBeVisible();
    expect(screen.queryByText("从左侧选择一个项目以启动终端")).not.toBeInTheDocument();
  });

  it("hides the launching/ready overlay once the leaf has a session", () => {
    renderTerminalTabContent(leafTab({ sessionId: "session-1" }, { sessionId: "session-1" }));

    expect(screen.queryByText("正在启动终端")).not.toBeInTheDocument();
    expect(screen.queryByText("准备就绪")).not.toBeInTheDocument();
  });

  it("shows the select-project hint only for an empty terminal tab", () => {
    renderTerminalTabContent(createTerminalTab({ projectId: "", projectPath: "" }));

    expect(screen.getByText("准备就绪")).toBeVisible();
    expect(screen.getByText("从左侧选择一个项目以启动终端")).toBeVisible();
    expect(screen.queryByText("正在启动终端")).not.toBeInTheDocument();
  });

  it.each([
    ["visible", true],
    ["hidden", false],
  ])("shows the restore log for a %s restoring leaf", (_label, visible) => {
    renderTerminalTabContent(leafTab({ restoring: true }), { visible });

    expect(screen.getByText("恢复日志")).toBeVisible();
    expect(screen.getByText("恢复链路初始化中...")).toBeVisible();
    expect(screen.queryByText("准备就绪")).not.toBeInTheDocument();
  });

  it("prints real restore events without the queued restore placeholder", () => {
    useTerminalRestoreLogStore.getState().append("tab-1", "leaf-1", "queue.queued", {
      active: 3,
      pending: 1,
    });
    renderTerminalTabContent(leafTab({ restoring: true }));

    expect(screen.getByRole("status")).toHaveTextContent(
      i18n.t("panes:restoreLog.events.queue_queued", { pending: 1, active: 3 }),
    );
    expect(screen.queryByText("排队恢复中")).not.toBeInTheDocument();
    expect(screen.queryByText("等待其他终端完成启动...")).not.toBeInTheDocument();
  });

  // 截图回归：恢复中的日志面曾整块叠在终端顶部、半透明底色透出冷重放的旧输出。
  // 未出问题时只给一行阶段标签（停在右下角、不透明底），完整日志点开才显示。
  it("collapses the in-progress restore log to one opaque status line", () => {
    const log = useTerminalRestoreLogStore.getState();
    log.append("tab-1", "leaf-1", "daemon-snapshot.begin", {});
    log.append("tab-1", "leaf-1", "init.listeners.begin", {});
    renderTerminalTabContent(leafTab({ restoring: true }));

    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(i18n.t("panes:restoreLog.events.init_listeners_begin"));
    expect(status).not.toHaveTextContent(i18n.t("panes:restoreLog.events.daemon-snapshot_begin"));
    const chip = status.closest("div.absolute") as HTMLElement | null;
    expect(chip?.className).toContain("bottom-3");
    expect(chip?.style.background).toBe("var(--app-overlay)");

    fireEvent.click(screen.getByRole("button", { name: i18n.t("panes:restoreLogExpand") }));
    expect(screen.getByRole("log")).toHaveTextContent(
      i18n.t("panes:restoreLog.events.daemon-snapshot_begin"),
    );
  });

  it("shows reconcile logs on a blocked restore surface", () => {
    useTerminalRestoreLogStore.getState().append("tab-1", "leaf-1", "identity.blocked", {
      reason: "identity-mismatch",
      sessionId: "sess-abcdef123456",
      gate: "project",
      field: "projectPath",
      values: { record: "D:\\work\\a", leaf: "D:\\work\\b" },
    });
    renderTerminalTabContent(leafTab({ restoring: true, restoreBlockedReason: "identity-mismatch" }));

    expect(screen.getByText("会话恢复已阻断")).toBeVisible();
    expect(screen.getByRole("log")).toHaveTextContent(
      i18n.t("panes:restoreLog.events.identity_blocked__identity-mismatch", {
        sessionId: "sess-abc",
        gate: i18n.t("panes:restoreLog.gate.project"),
        field: "projectPath",
        values: "record=D:\\work\\a / leaf=D:\\work\\b",
      }),
    );
    // 日志必须点名是哪一关、哪个字段、三方各是什么值——本轮返工的直接起因就是
    // 旧文案写死「CLI、运行环境或项目路径对不上」，而那三样当时全是对的。
    expect(screen.getByRole("log")).toHaveTextContent("projectPath");
    expect(screen.getByRole("log")).toHaveTextContent("record=D:\\work\\a");
    // 原始事件名默认收起，展开「原始详情」后才出现。
    expect(screen.getByRole("log")).not.toHaveTextContent("identity.blocked");
    fireEvent.click(screen.getByText(i18n.t("panes:restoreLogDetails")));
    expect(screen.getByRole("log")).toHaveTextContent("identity.blocked");
    expect(screen.getByRole("log")).toHaveTextContent("identity-mismatch");
  });

  const legacyDaemonLeaf = () => leafTab({
    restoring: true,
    savedSessionId: "old-session",
    restoreBlockedReason: "claims-unsupported",
  });

  it("offers an explicit cold restore for a live legacy-daemon session", async () => {
    coldRestoreMock.mockResolvedValue(undefined);
    renderTerminalTabContent(legacyDaemonLeaf());

    expect(screen.getByText("需要恢复旧会话")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "结束旧终端并恢复" }));

    await waitFor(() => {
      expect(coldRestoreMock).toHaveBeenCalledWith("tab-1", "leaf-1");
    });
  });

  it("keeps the blocked surface and reports a failed legacy-daemon kill", async () => {
    coldRestoreMock.mockRejectedValue(new Error("daemon unavailable"));
    renderTerminalTabContent(legacyDaemonLeaf());

    fireEvent.click(screen.getByRole("button", { name: "结束旧终端并恢复" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("旧终端未能结束");
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
  });
});

describe("TerminalTabContent 启动失败提示（L2-2）", () => {
  it("leaf.launchFailure 存在且无会话时显示修复命令，且不阻断 TerminalView 重新启动", () => {
    const wsl = { remotePath: "/mnt/d/repo", distro: "Ubuntu" };
    renderTerminalTabContent(leafTab({
      cliTool: "claude",
      wsl,
      launchFailure: {
        reason: "native-cli-missing",
        at: 1,
        missingCli: "claude",
        fixHint: "npm i -g @anthropic-ai/claude-code",
        wslDistro: "Ubuntu",
      },
    }, { cliTool: "claude", wsl }));
    const hint = screen.getByTestId("terminal-launch-failure-hint");
    expect(hint.textContent).toContain("npm i -g @anthropic-ai/claude-code");
    expect(hint.textContent).toContain("claude");
    // 提示是覆盖层，不替代终端：用户重新启动时 TerminalView 照常挂载
    expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
  });

  it("有会话后不再显示启动失败提示", () => {
    renderTerminalTabContent(leafTab({
      sessionId: "pty-live",
      cliTool: "claude",
      launchFailure: { reason: "native-cli-missing", at: 1, fixHint: "x" },
    }));
    expect(screen.queryByTestId("terminal-launch-failure-hint")).toBeNull();
  });
});
