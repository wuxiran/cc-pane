import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MiniView from "./MiniView";
import { usePanesStore, useMiniModeStore } from "@/stores";
import { createPanel,  } from "@/stores/paneTreeHelpers";
import { createTab } from "@/stores/usePanesStore";
import type { Tab } from "@/types";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    startDragging: vi.fn(() => Promise.resolve()),
  })),
}));

function sessionTab(title: string, sessionId: string | null): Tab {
  return { ...createTab({ projectId: "proj", projectPath: "/repo" }), title, sessionId };
}

function seedPanes(tabs: Tab[]) {
  const panel = createPanel(tabs[0]);
  panel.tabs = tabs;
  panel.activeTabId = tabs[0].id;
  usePanesStore.setState({ rootPane: panel, currentLayoutId: "layout-1" });
}

describe("MiniView", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    seedPanes([sessionTab("会话A", "sess-1"), sessionTab("会话B", "sess-2")]);
    useMiniModeStore.setState({ isMiniMode: true, isTransitioning: false });
  });

  it("渲染带 sessionId 的会话标签", () => {
    render(<MiniView />);
    expect(screen.getByText("会话A")).toBeInTheDocument();
    expect(screen.getByText("会话B")).toBeInTheDocument();
  });

  it("过滤掉没有 sessionId 的标签", () => {
    seedPanes([sessionTab("有会话", "sess-1"), sessionTab("无会话", null)]);
    render(<MiniView />);
    expect(screen.getByText("有会话")).toBeInTheDocument();
    expect(screen.queryByText("无会话")).not.toBeInTheDocument();
  });

  it("无活跃会话时显示空态提示", () => {
    seedPanes([sessionTab("无会话", null)]);
    render(<MiniView />);
    expect(screen.getByText(/无活跃会话|No active sessions/i)).toBeInTheDocument();
  });

  it("点击置顶按钮调用 toggle_always_on_top", async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockResolvedValue(false);
    render(<MiniView />);

    await user.click(screen.getByTitle(/取消置顶|Unpin/i));
    expect(invoke).toHaveBeenCalledWith("toggle_always_on_top");

    // 返回 false 后按钮切换为 "置顶" 语义
    await waitFor(() => expect(screen.getByTitle(/窗口置顶|Pin Window/i)).toBeInTheDocument());
  });

  it("置顶接口报错时静默处理，不崩溃", async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    render(<MiniView />);
    await user.click(screen.getByTitle(/取消置顶|Unpin/i));
    // 仍保持初始置顶态
    expect(screen.getByTitle(/取消置顶|Unpin/i)).toBeInTheDocument();
  });

  it("点击恢复按钮退出迷你模式", async () => {
    const user = userEvent.setup();
    const exitSpy = vi.fn();
    useMiniModeStore.setState({ exitMiniMode: exitSpy });
    render(<MiniView />);

    await user.click(screen.getByTitle(/恢复窗口|Restore Window/i));
    expect(exitSpy).toHaveBeenCalled();
  });

  it("双击会话标签定位并退出迷你模式", async () => {
    const user = userEvent.setup();
    const exitSpy = vi.fn();
    const switchLayout = vi.fn();
    const setActivePane = vi.fn();
    const selectTab = vi.fn();
    useMiniModeStore.setState({ exitMiniMode: exitSpy });
    usePanesStore.setState({
      findTabAcrossLayouts: () => null,
      switchLayout,
      setActivePane,
      selectTab,
    });

    render(<MiniView />);
    await user.dblClick(screen.getByText("会话A"));

    expect(setActivePane).toHaveBeenCalled();
    expect(selectTab).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalled();
  });
});
