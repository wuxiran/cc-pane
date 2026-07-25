import "@/i18n";
import type { ReactElement } from "react";
import { act, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import LayoutTopBar from "./LayoutTopBar";
import {
  useActivityBarStore,
  useLayoutUiStore,
  usePanesStore,
  useTerminalStatusStore,
  useWorkspacesStore,
} from "@/stores";
import { createPanel } from "@/stores/paneTreeHelpers";
import type { Panel, PaneNode, SplitPane, Tab, TerminalStatusInfo } from "@/types";

const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

// LayoutDeleteDialog 依赖 tauri webviewWindow 与 sonner，测试环境不可用需 mock
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: vi.fn(),
  },
}));

function resetStores(rootPane: PaneNode = createPanel()) {
  const starredRootPane = createPanel();
  usePanesStore.setState({
    rootPane,
    activePaneId: rootPane.id,
    layouts: [
      {
        id: "layout-1",
        name: "布局 1",
        kind: "normal",
        rootPane,
        activePaneId: rootPane.id,
      },
      {
        id: "layout-starred",
        name: "星标",
        kind: "starred",
        rootPane: starredRootPane,
        activePaneId: starredRootPane.id,
      },
    ],
    currentLayoutId: "layout-1",
    closedTabs: [],
    poppedOutTabs: new Set<string>(),
  });
  useActivityBarStore.setState({
    activeView: "explorer",
    sidebarVisible: true,
    appViewMode: "panes",
    orchestrationOverlayOpen: false,
  });
  useLayoutUiStore.setState({
    switcherMode: "topbar",
    layoutBarDensity: "comfortable",
  });
  useTerminalStatusStore.setState({ statusMap: new Map() });
  useWorkspacesStore.setState({
    workspaces: [
      {
        id: "workspace-1",
        name: "workspace",
        createdAt: "2026-07-25",
        projects: [
          { id: "project-a", path: "/work/cc-book" },
          { id: "project-b", path: "/work/vms" },
          { id: "project-c", path: "/work/erp" },
        ],
      },
    ],
  });
}

function terminalTab(
  id: string,
  projectId: string,
  projectPath: string,
  sessionId: string | null = null,
): Tab {
  return {
    id,
    title: id,
    contentType: "terminal",
    projectId,
    projectPath,
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

function presetButtons() {
  const group = screen.getByRole("group");
  return within(group).getAllByRole("button");
}

describe("LayoutTopBar 布局预设按钮", () => {
  beforeEach(() => {
    resetStores();
  });

  it("渲染 6 个预设按钮", () => {
    render(<LayoutTopBar />);
    expect(presetButtons()).toHaveLength(6);
  });

  it("点击预设按钮重排当前布局并高亮命中预设", () => {
    render(<LayoutTopBar />);
    const buttons = presetButtons();

    // 初始：单 panel 根 → 命中 single（第 1 个按钮）
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("false");

    // 点击 two-col（第 2 个按钮）
    fireEvent.click(buttons[1]);

    const root = usePanesStore.getState().rootPane as SplitPane;
    expect(root.type).toBe("split");
    expect(root.direction).toBe("horizontal");
    expect(root.children).toHaveLength(2);
    expect(root.children.every((child) => child.type === "panel")).toBe(true);

    const after = presetButtons();
    expect(after[0].getAttribute("aria-pressed")).toBe("false");
    expect(after[1].getAttribute("aria-pressed")).toBe("true");
  });

  it("重排保留现有 Panel id", () => {
    const pane = createPanel();
    resetStores(pane);
    render(<LayoutTopBar />);

    fireEvent.click(presetButtons()[3]); // two-row

    const root = usePanesStore.getState().rootPane as SplitPane;
    expect((root.children[0] as Panel).id).toBe(pane.id);
  });

  it("当前是星标布局时不渲染预设组", () => {
    usePanesStore.setState({ currentLayoutId: "layout-starred" });
    render(<LayoutTopBar />);
    expect(screen.queryByRole("group")).toBeNull();
  });
});

describe("LayoutTopBar 布局条密度", () => {
  beforeEach(() => {
    resetStores();
  });

  it("默认渲染舒适档，切换后渲染紧凑档且星标布局保持可用", async () => {
    const user = userEvent.setup();
    render(<LayoutTopBar />);

    expect(screen.getByRole("tablist")).toHaveAttribute("data-density", "comfortable");
    expect(screen.getAllByText(/空闲|Idle/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: /星标/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /切换到紧凑档|Switch to compact/i }));

    expect(useLayoutUiStore.getState().layoutBarDensity).toBe("compact");
    expect(screen.getByRole("tablist")).toHaveAttribute("data-density", "compact");
    expect(screen.queryAllByText(/空闲|Idle/i)).toHaveLength(0);
    expect(screen.getByRole("tab", { name: /星标/ })).toBeInTheDocument();
  });

  it("舒适档摘要行按状态桶展示计数，零桶隐藏且不再出现项目名", () => {
    const rootPane = createPanel();
    rootPane.tabs = [
      terminalTab("tab-a-1", "project-a", "/work/cc-book", "s-run-1"),
      terminalTab("tab-a-2", "project-a", "/work/cc-book", "s-run-2"),
      terminalTab("tab-b", "project-b", "/work/vms", "s-wait"),
      terminalTab("tab-c", "project-c", "/work/erp"),
    ];
    resetStores(rootPane);
    useTerminalStatusStore.setState({
      statusMap: new Map([
        ["s-run-1", status("s-run-1", "thinking")],
        ["s-run-2", status("s-run-2", "toolRunning")],
        ["s-wait", status("s-wait", "waitingInput")],
      ]),
    });

    render(<LayoutTopBar />);

    // 运行中 2、等待授权 1；无 error 会话 → 阻塞桶隐藏。
    // 等待授权 title 与名称行状态点共用文案，按"含计数"过滤出摘要桶。
    expect(screen.getByTitle(/^(运行中|Running)$/).textContent).toBe("2");
    const waitBuckets = screen.getAllByTitle(/^(等待授权|Awaiting approval)$/);
    expect(waitBuckets.some((el) => el.textContent === "1")).toBe(true);
    expect(screen.queryAllByTitle(/^(错误|Error)$/)).toHaveLength(0);
    expect(screen.queryByText("cc-book")).not.toBeInTheDocument();
    expect(screen.queryByText("erp")).not.toBeInTheDocument();
  });

  it("状态摘要随 panes/status store 更新即时重新派生", () => {
    render(<LayoutTopBar />);
    expect(screen.getAllByText(/空闲|Idle/i).length).toBeGreaterThan(0);

    const rootPane = createPanel(terminalTab("tab-a", "project-a", "/work/cc-book", "s-run"));
    act(() => {
      usePanesStore.setState({ rootPane, activePaneId: rootPane.id });
      useTerminalStatusStore.setState({
        statusMap: new Map([["s-run", status("s-run", "thinking")]]),
      });
    });

    expect(screen.getByTitle(/^(运行中|Running)$/).textContent).toBe("1");
  });

  it("旧 pane 状态点在两档中保持相同语义", async () => {
    const user = userEvent.setup();
    const busyPanel = createPanel(terminalTab("tab-busy", "project-a", "/work/cc-book", "busy"));
    const errorPanel = createPanel(terminalTab("tab-error", "project-b", "/work/vms", "error"));
    const rootPane: SplitPane = {
      type: "split",
      id: "split-root",
      direction: "horizontal",
      children: [busyPanel, errorPanel],
      sizes: [50, 50],
    };
    resetStores(rootPane);
    useTerminalStatusStore.setState({
      statusMap: new Map([
        ["busy", status("busy", "toolRunning")],
        ["error", status("error", "error")],
      ]),
    });

    render(<LayoutTopBar />);

    // 舒适档：名称行不再放状态点，状态只出现在摘要行状态桶(运行中/错误)
    expect(screen.queryAllByTitle(/工具运行|Running tool/i)).toHaveLength(0);
    expect(screen.getAllByTitle(/^(运行中|Running)$/)).toHaveLength(1);
    expect(screen.getAllByTitle(/^(错误|Error)$/)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /切换到紧凑档|Switch to compact/i }));

    // 紧凑档无摘要行：名称行状态点是唯一状态信号
    expect(screen.getAllByTitle(/工具运行|Running tool/i)).toHaveLength(1);
    expect(screen.queryAllByTitle(/^(运行中|Running)$/)).toHaveLength(0);
    expect(screen.getAllByTitle(/^(错误|Error)$/)).toHaveLength(1);
  });

  it("右键菜单提供同一密度切换动作", async () => {
    const user = userEvent.setup();
    render(<LayoutTopBar />);

    fireEvent.contextMenu(screen.getByRole("tab", { name: /布局 1/ }));
    await user.click(await screen.findByRole("menuitem", { name: /切换到紧凑档|Switch to compact/i }));

    expect(useLayoutUiStore.getState().layoutBarDensity).toBe("compact");
  });
});
