import "@/i18n";
import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogStore, usePanesStore, useTerminalStatusStore } from "@/stores";
import type { Panel, Tab, TerminalStatusInfo, TerminalStatusType } from "@/types";
import HomeActiveSessions from "./HomeActiveSessions";

function createTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    title: "会话一",
    contentType: "terminal",
    projectId: "p1",
    projectPath: "D:/proj/demo",
    sessionId: "sess-1",
    ...overrides,
  };
}

function panelWith(tabs: Tab[]): Panel {
  return { type: "panel", id: "panel-1", tabs, activeTabId: tabs[0]?.id ?? "" };
}

function statusEntry(
  sessionId: string,
  status: TerminalStatusType,
): [string, TerminalStatusInfo] {
  return [
    sessionId,
    { sessionId, status, lastOutputAt: 0, updatedAt: 0 },
  ];
}

describe("HomeActiveSessions", () => {
  beforeEach(() => {
    usePanesStore.setState({
      rootPane: panelWith([]),
      currentLayoutId: "layout-1",
    });
    useTerminalStatusStore.setState({ statusMap: new Map() });
  });

  it("无活跃会话时渲染空态", () => {
    render(<HomeActiveSessions />);

    expect(screen.getByText("暂无活跃会话")).toBeVisible();
  });

  it("无 sessionId 的标签不计入活跃会话", () => {
    usePanesStore.setState({
      rootPane: panelWith([
        createTab({ id: "t1", sessionId: null, title: "编辑器" }),
      ]),
    });
    render(<HomeActiveSessions />);

    expect(screen.getByText("暂无活跃会话")).toBeVisible();
  });

  it("递归收集 split 布局下的所有会话标签", () => {
    usePanesStore.setState({
      rootPane: {
        type: "split",
        id: "split-1",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { type: "panel", id: "p1", tabs: [createTab({ id: "t1", title: "左侧" })], activeTabId: "t1" },
          { type: "panel", id: "p2", tabs: [createTab({ id: "t2", title: "右侧", sessionId: "sess-2" })], activeTabId: "t2" },
        ],
      },
    });
    render(<HomeActiveSessions />);

    expect(screen.getByText("左侧")).toBeVisible();
    expect(screen.getByText("右侧")).toBeVisible();
    expect(screen.getByText("共 2 个终端会话")).toBeVisible();
  });

  it("最多展示 5 条，底部统计显示全部数量", () => {
    const tabs = Array.from({ length: 7 }, (_, i) =>
      createTab({ id: `t${i}`, title: `会话${i}`, sessionId: `s${i}` }),
    );
    usePanesStore.setState({ rootPane: panelWith(tabs) });
    render(<HomeActiveSessions />);

    expect(screen.getByText("会话4")).toBeVisible();
    expect(screen.queryByText("会话5")).not.toBeInTheDocument();
    expect(screen.getByText("共 7 个终端会话")).toBeVisible();
  });

  it("按会话状态显示运行中/等待输入/空闲标签", () => {
    usePanesStore.setState({
      rootPane: panelWith([
        createTab({ id: "t1", title: "忙碌", sessionId: "s1" }),
        createTab({ id: "t2", title: "等待", sessionId: "s2" }),
        createTab({ id: "t3", title: "闲置", sessionId: "s3" }),
      ]),
    });
    useTerminalStatusStore.setState({
      statusMap: new Map([
        statusEntry("s1", "thinking"),
        statusEntry("s2", "waitingInput"),
      ]),
    });
    render(<HomeActiveSessions />);

    expect(screen.getByText("运行中")).toBeVisible();
    expect(screen.getByText("等待输入")).toBeVisible();
    expect(screen.getByText("空闲")).toBeVisible();
  });

  it("标题为空时回退为项目路径末段", () => {
    usePanesStore.setState({
      rootPane: panelWith([
        createTab({ id: "t1", title: "", projectPath: "D:\\proj\\my-app" }),
      ]),
    });
    render(<HomeActiveSessions />);

    expect(screen.getByText("my-app")).toBeVisible();
  });

  it("点击会话：同布局直接聚焦面板与标签", () => {
    const tab = createTab({ id: "t1" });
    const panel = panelWith([tab]);
    const findTabAcrossLayouts = vi.fn(() => ({
      layoutId: "layout-1",
      panel,
      tab,
    }));
    const switchLayout = vi.fn();
    const setActivePane = vi.fn();
    const selectTab = vi.fn();
    usePanesStore.setState({
      rootPane: panel,
      currentLayoutId: "layout-1",
      findTabAcrossLayouts,
      switchLayout,
      setActivePane,
      selectTab,
    } as never);
    render(<HomeActiveSessions />);

    fireEvent.click(screen.getByText("会话一"));

    expect(switchLayout).not.toHaveBeenCalled();
    expect(setActivePane).toHaveBeenCalledWith("panel-1");
    expect(selectTab).toHaveBeenCalledWith("panel-1", "t1");
  });

  it("点击会话：跨布局先切换布局再聚焦", () => {
    const tab = createTab({ id: "t1" });
    const panel = panelWith([tab]);
    const switchLayout = vi.fn();
    const setActivePane = vi.fn();
    const selectTab = vi.fn();
    usePanesStore.setState({
      rootPane: panel,
      currentLayoutId: "layout-1",
      findTabAcrossLayouts: vi.fn(() => ({ layoutId: "layout-2", panel, tab })),
      switchLayout,
      setActivePane,
      selectTab,
    } as never);
    render(<HomeActiveSessions />);

    fireEvent.click(screen.getByText("会话一"));

    expect(switchLayout).toHaveBeenCalledWith("layout-2");
    expect(setActivePane).toHaveBeenCalledWith("panel-1");
  });

  it("点击会话：找不到标签位置时不做任何切换", () => {
    const setActivePane = vi.fn();
    usePanesStore.setState({
      rootPane: panelWith([createTab({ id: "t1" })]),
      findTabAcrossLayouts: vi.fn(() => null),
      setActivePane,
    } as never);
    render(<HomeActiveSessions />);

    fireEvent.click(screen.getByText("会话一"));

    expect(setActivePane).not.toHaveBeenCalled();
  });

  it("空态渲染终端插画、引导文案与新建终端按钮", () => {
    const { container } = render(<HomeActiveSessions />);

    expect(
      container.querySelector("svg[data-illustration='empty-terminal']"),
    ).toBeInTheDocument();
    expect(screen.getByText("暂无活跃会话")).toBeVisible();
    expect(screen.getByText(/新建一个终端会话/)).toBeVisible();
    expect(screen.getByRole("button", { name: "新建终端" })).toBeVisible();
  });

  it("空态容器带静态 dot-grid 纹理底", () => {
    render(<HomeActiveSessions />);

    const empty = screen.getByTestId("home-active-sessions-empty");
    expect(empty.style.backgroundImage).toContain("radial-gradient");
    expect(empty.style.backgroundImage).toContain("var(--app-text-tertiary)");
    expect(empty.style.backgroundSize).toBe("20px 20px");
  });

  it("空态点击新建终端按钮打开启动器", () => {
    const openLauncher = vi.fn();
    useDialogStore.setState({ openLauncher });
    render(<HomeActiveSessions />);

    fireEvent.click(screen.getByRole("button", { name: "新建终端" }));

    expect(openLauncher).toHaveBeenCalledTimes(1);
  });

  it("会话统计数字使用 tabular-nums", () => {
    usePanesStore.setState({ rootPane: panelWith([createTab()]) });
    render(<HomeActiveSessions />);

    expect(screen.getByText("共 1 个终端会话")).toHaveClass("tabular-nums");
  });

  it("空态引导文案在 en 语言环境下有对应翻译", () => {
    const tEn = i18n.getFixedT("en", "home");

    expect(tEn("noActiveSessionsHint")).not.toBe("noActiveSessionsHint");
    expect(tEn("noActiveSessionsHint").length).toBeGreaterThan(0);
  });
});
