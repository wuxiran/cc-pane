import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Tab } from "@/types";
import { usePanesStore, useTerminalRestoreLogStore } from "@/stores";
import TerminalTabContent from "./TerminalTabContent";

vi.mock("./TerminalView", () => ({
  default: vi.fn((props: { onRestoreLaunchState?: (state: string) => void }) => (
    <button
      data-testid="terminal-view"
      onClick={() => props.onRestoreLaunchState?.("queued")}
      onDoubleClick={() => props.onRestoreLaunchState?.("failed")}
    />
  )),
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

function renderTerminalTabContent(tab: Tab, options?: { isVisible?: boolean; isActive?: boolean }) {
  render(
    <TooltipProvider>
      <TerminalTabContent
        tab={tab}
        isVisible={options?.isVisible ?? true}
        isActive={options?.isActive ?? true}
        layoutActive
        onSessionCreated={vi.fn()}
        onSessionExited={vi.fn()}
        onTerminalRef={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe("TerminalTabContent", () => {
  beforeEach(() => useTerminalRestoreLogStore.getState().reset());

  it("shows a persistent launch error with retry and remove actions", () => {
    const retryTerminalLaunch = vi.fn();
    const removeTerminalLaunch = vi.fn();
    usePanesStore.setState({ retryTerminalLaunch, removeTerminalLaunch } as never);
    renderTerminalTabContent(
      createTerminalTab({
        launchError: {
          code: "PATH_NOT_FOUND",
          message: "Launch directory does not exist",
          params: { path: "/missing/repo" },
        },
        terminalRootPane: {
          type: "leaf",
          id: "leaf-1",
          sessionId: null,
          launchError: {
            code: "PATH_NOT_FOUND",
            message: "Launch directory does not exist",
            params: { path: "/missing/repo" },
          },
        },
      }),
    );

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

  it("hides ready overlay once the leaf has a session", () => {
    renderTerminalTabContent(
      createTerminalTab({
        sessionId: "session-1",
        terminalRootPane: {
          type: "leaf",
          id: "leaf-1",
          sessionId: "session-1",
        },
      }),
    );

    expect(screen.queryByText("准备就绪")).not.toBeInTheDocument();
  });

  it("shows the restore log while a visible leaf is restoring", () => {
    renderTerminalTabContent(
      createTerminalTab({
        terminalRootPane: {
          type: "leaf",
          id: "leaf-1",
          sessionId: null,
          restoring: true,
        },
      }),
    );

    expect(screen.getByText("恢复日志")).toBeVisible();
    expect(screen.getByText("恢复链路初始化中...")).toBeVisible();
    expect(screen.queryByText("准备就绪")).not.toBeInTheDocument();
  });

  it("shows restoring overlay for a hidden restoring leaf", () => {
    renderTerminalTabContent(
      createTerminalTab({
        terminalRootPane: {
          type: "leaf",
          id: "leaf-1",
          sessionId: null,
          restoring: true,
        },
      }),
      { isVisible: false, isActive: false },
    );

    expect(screen.getByText("恢复日志")).toBeVisible();
    expect(screen.getByText("恢复链路初始化中...")).toBeVisible();
  });

  it("prints real restore events without the queued restore placeholder", () => {
    useTerminalRestoreLogStore.getState().append("tab-1", "leaf-1", "queue.queued", {
      active: 3,
      pending: 1,
    });
    renderTerminalTabContent(
      createTerminalTab({
        terminalRootPane: {
          type: "leaf",
          id: "leaf-1",
          sessionId: null,
          restoring: true,
        },
      }),
    );

    expect(screen.getByRole("log")).toHaveTextContent("[layout-restore] queue.queued");
    expect(screen.getByRole("log")).toHaveTextContent('"active":3,"pending":1');
    expect(screen.queryByText("排队恢复中")).not.toBeInTheDocument();
    expect(screen.queryByText("等待其他终端完成启动...")).not.toBeInTheDocument();
  });

  it("shows reconcile logs on a blocked restore surface", () => {
    useTerminalRestoreLogStore.getState().append("tab-1", "leaf-1", "identity.blocked", {
      reason: "identity-mismatch",
    });
    renderTerminalTabContent(
      createTerminalTab({
        terminalRootPane: {
          type: "leaf",
          id: "leaf-1",
          sessionId: null,
          restoring: true,
          restoreBlockedReason: "identity-mismatch",
        },
      }),
    );

    expect(screen.getByText("会话恢复已阻断")).toBeVisible();
    expect(screen.getByRole("log")).toHaveTextContent("identity.blocked");
    expect(screen.getByRole("log")).toHaveTextContent("identity-mismatch");
  });

  it("shows the select-project hint only for an empty terminal tab", () => {
    renderTerminalTabContent(
      createTerminalTab({
        projectId: "",
        projectPath: "",
      }),
    );

    expect(screen.getByText("准备就绪")).toBeVisible();
    expect(screen.getByText("从左侧选择一个项目以启动终端")).toBeVisible();
    expect(screen.queryByText("正在启动终端")).not.toBeInTheDocument();
  });
});
