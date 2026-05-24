import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Tab } from "@/types";
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
        onSessionCreated={vi.fn()}
        onSessionExited={vi.fn()}
        onTerminalRef={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe("TerminalTabContent", () => {
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

  it("shows restoring overlay while a visible leaf is restoring", () => {
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

    expect(screen.getByText("正在恢复会话")).toBeVisible();
    expect(screen.getByText("正在启动保存的终端会话...")).toBeVisible();
    expect(screen.queryByText("准备就绪")).not.toBeInTheDocument();
  });

  it("shows waiting overlay for a hidden restoring leaf", () => {
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

    expect(screen.getByText("等待恢复")).toBeVisible();
    expect(screen.getByText("切换到此标签后启动保存的会话")).toBeVisible();
  });

  it("shows queued restore state reported by the terminal view", () => {
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

    fireEvent.click(screen.getByTestId("terminal-view"));

    expect(screen.getByText("排队恢复中")).toBeVisible();
    expect(screen.getByText("等待其他终端完成启动...")).toBeVisible();
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
