import "@/i18n";
import { act, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DndContext } from "@dnd-kit/core";
import LayoutTopBar from "./LayoutTopBar";
import {
  useActivityBarStore,
  useLayoutUiStore,
  usePanesStore,
  useTerminalStatusStore,
  useWorkspacesStore,
} from "@/stores";
import { createPanel } from "@/lib/paneTree";
import type { Panel, PaneNode, SplitPane, Tab, TerminalStatusInfo } from "@/types";

const renderBar = () => rtlRender(<TooltipProvider><DndContext><LayoutTopBar /></DndContext></TooltipProvider>);

// LayoutDeleteDialog 依赖 tauri webviewWindow 与全局 toast，测试环境不可用需 mock
vi.mock("@/components/ui/toast", () => ({
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

const { navigateToSettingsMock } = vi.hoisted(() => ({
  navigateToSettingsMock: vi.fn(),
}));
vi.mock("@/components/settings/settingsNavigation", () => ({
  navigateToSettings: (...args: unknown[]) => navigateToSettingsMock(...args),
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

function presetTrigger() {
  return screen.getByRole("button", { name: /布局预设|Layout presets/i });
}

function presetDialog() {
  return screen.getByRole("dialog", { name: /布局预设|Layout presets/i });
}

function viewTrigger() {
  return screen.getByTestId("layout-view-trigger");
}

async function openViewMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(viewTrigger());
  return screen.findByRole("menu", { name: /布局视图选项|Layout view options/i });
}

describe("LayoutTopBar 布局预设浮层", () => {
  beforeEach(() => {
    resetStores();
    navigateToSettingsMock.mockClear();
  });

  it("舒适档：星标 / 预设纯图标，不再有 Agent Chat 固定入口与自动适配按钮", () => {
    renderBar();

    const cluster = screen.getByTestId("layout-preset-cluster");
    expect(cluster).toHaveAttribute("data-density", "comfortable");
    expect(within(cluster).queryByTestId("layout-special-agent-chat")).toBeNull();
    expect(within(cluster).getByTestId("layout-special-starred")).toBeInTheDocument();
    // 自动化入口只在左侧活动栏，布局条不再重复放
    expect(within(cluster).queryByTestId("layout-special-automations")).toBeNull();
    expect(within(cluster).getByRole("button", { name: /布局预设|Layout presets/i })).toBe(presetTrigger());
    expect(within(presetTrigger()).queryByText(/^(单格|Single|布局预设|Layout presets)$/)).not.toBeInTheDocument();
    expect(within(cluster).getByTestId("layout-special-starred")).not.toHaveTextContent(/星标|Starred/);
    // 自动适配布局开关只留在 corner 模式选择面板，顶栏不再放
    expect(screen.queryByRole("button", { name: /自动适配布局|Auto-fit layout/i })).toBeNull();
  });

  it("布局卡片从最左开始排，工具组（视图 / 星标预设簇 / 新建）固定在右端", () => {
    renderBar();

    const bar = screen.getByRole("tablist");
    const strip = screen.getByTestId("layout-strip");
    const tools = screen.getByTestId("layout-tools");
    const add = screen.getByRole("button", { name: /新建布局|New layout/i });
    expect(bar.firstElementChild).toBe(strip);
    expect(strip.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip).not.toContainElement(tools);
    const ordered = [viewTrigger(), screen.getByTestId("layout-preset-cluster"), add];
    ordered.forEach((element) => expect(tools).toContainElement(element));
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i - 1].compareDocumentPosition(ordered[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("常驻入口收敛为单按钮，点开浮层列出 6 个带文字标签的预设", () => {
    renderBar();

    // 初始单 panel 根命中 single；入口改为纯图标，名称走 aria-label / tooltip
    expect(presetTrigger().getAttribute("aria-expanded")).toBe("false");
    expect(presetTrigger().getAttribute("aria-label")).toMatch(/布局预设|Layout presets/);

    fireEvent.click(presetTrigger());

    expect(presetTrigger().getAttribute("aria-expanded")).toBe("true");
    const options = within(presetDialog()).getAllByTestId("layout-preset-option");
    expect(options).toHaveLength(6);
    // 当前命中的预设带 aria-pressed 高亮；每个选项都有文字标签（不再纯图标）
    expect(options[0].getAttribute("aria-pressed")).toBe("true");
    expect(options[1].getAttribute("aria-pressed")).toBe("false");
    expect(within(options[1]).getByText(/^(左右分栏|Two columns)$/)).toBeInTheDocument();
    // 星标是簇上的常驻按钮，不再进浮层
    expect(within(presetDialog()).queryByTestId("layout-special-starred")).toBeNull();
  });

  it("点选预设生效并关闭浮层", () => {
    renderBar();
    fireEvent.click(presetTrigger());

    const options = within(presetDialog()).getAllByTestId("layout-preset-option");
    fireEvent.click(options[1]); // two-col

    const root = usePanesStore.getState().rootPane as SplitPane;
    expect(root.type).toBe("split");
    expect(root.direction).toBe("horizontal");
    expect(root.children).toHaveLength(2);
    expect(root.children.every((child) => child.type === "panel")).toBe(true);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(presetTrigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("重排保留现有 Panel id", () => {
    const pane = createPanel();
    resetStores(pane);
    renderBar();
    fireEvent.click(presetTrigger());

    const options = within(presetDialog()).getAllByTestId("layout-preset-option");
    fireEvent.click(options[3]); // two-row

    const root = usePanesStore.getState().rootPane as SplitPane;
    expect((root.children[0] as Panel).id).toBe(pane.id);
  });

  it.each([
    ["Escape", () => fireEvent.keyDown(presetDialog(), { key: "Escape" })],
    // 顶栏本体（触发按钮容器之外）也算浮层外
    ["点击浮层外", () => fireEvent.pointerDown(screen.getByRole("tablist"))],
    ["再次点击触发按钮", () => fireEvent.click(presetTrigger())],
  ] as const)("%s 关闭浮层", (_label, close) => {
    renderBar();
    fireEvent.click(presetTrigger());
    expect(presetDialog()).toBeInTheDocument();

    close();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(presetTrigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("当前是星标布局时预设入口仍在，星标按钮呈按下态", () => {
    usePanesStore.setState({ currentLayoutId: "layout-starred" });
    renderBar();
    expect(presetTrigger()).toBeInTheDocument();
    expect(screen.getByTestId("layout-special-starred").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("tab", { name: /星标|Starred/ })).toBeNull();
  });

  it("顶栏卡片不展示星标，点簇上按钮可切过去", () => {
    renderBar();
    expect(screen.queryByRole("tab", { name: /星标|Starred/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /布局 1/ })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("layout-special-starred"));
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-starred");
  });

  it("旧 Agent Chat 布局作为普通卡片出现在顶栏", () => {
    const current = usePanesStore.getState();
    const agentRoot = createPanel();
    usePanesStore.setState({
      layouts: [...current.layouts, { id: "layout-agent-chat", name: "Agent Chat", kind: "normal", rootPane: agentRoot, activePaneId: agentRoot.id }],
    });
    renderBar();
    fireEvent.click(screen.getByRole("tab", { name: /Agent Chat/ }));
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-agent-chat");
  });

});

describe("LayoutTopBar 布局条密度", () => {
  beforeEach(() => {
    resetStores();
  });

  it("默认渲染舒适档，切换后渲染紧凑档且星标布局保持可用", async () => {
    const user = userEvent.setup();
    renderBar();

    expect(screen.getByRole("tablist")).toHaveAttribute("data-density", "comfortable");
    expect(screen.getAllByText(/无会话|No sessions/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("tab", { name: /星标/ })).toBeNull();

    const menu = await openViewMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /切换到紧凑档|Switch to compact/i }));

    expect(useLayoutUiStore.getState().layoutBarDensity).toBe("compact");
    expect(screen.getByRole("tablist")).toHaveAttribute("data-density", "compact");
    expect(screen.getByTestId("layout-preset-cluster")).toHaveAttribute("data-density", "compact");
    expect(screen.queryAllByText(/无会话|No sessions/i)).toHaveLength(0);
    expect(screen.getByTestId("layout-special-starred")).toBeInTheDocument();
    fireEvent.click(presetTrigger());
    expect(within(presetDialog()).queryByTestId("layout-special-starred")).toBeNull();
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

    renderBar();

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
    renderBar();
    expect(screen.getAllByText(/无会话|No sessions/i).length).toBeGreaterThan(0);

    const rootPane = createPanel(terminalTab("tab-a", "project-a", "/work/cc-book", "s-run"));
    act(() => {
      usePanesStore.setState({ rootPane, activePaneId: rootPane.id });
      useTerminalStatusStore.setState({
        statusMap: new Map([["s-run", status("s-run", "thinking")]]),
      });
    });

    expect(screen.getByTitle(/^(运行中|Running)$/).textContent).toBe("1");
  });

  // 此前紧凑档走 LayoutStatusDots（按 **pane** 聚合，显 StatusIndicator 的细分
  // 状态如"工具运行"），舒适档走按 **session** 计数的状态桶——同一张卡换个密度
  // 语义就变。现已统一到 session 口径，两档读数必须一致。
  it("两档状态读数口径一致（同为按会话计数的状态桶）", async () => {
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

    renderBar();

    // 舒适档：运行中 1、错误 1，各自带计数；不出现 pane 级的细分状态文案
    expect(screen.queryAllByTitle(/工具运行|Running tool/i)).toHaveLength(0);
    expect(screen.getByTitle(/^(运行中|Running)$/).textContent).toBe("1");
    expect(screen.getByTitle(/^(错误|Error)$/).textContent).toBe("1");

    const menu = await openViewMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /切换到紧凑档|Switch to compact/i }));

    // 紧凑档：同样的桶、同样的读数——不再退回 pane 级聚合
    expect(screen.queryAllByTitle(/工具运行|Running tool/i)).toHaveLength(0);
    expect(screen.getByTitle(/^(运行中|Running)$/).textContent).toBe("1");
    expect(screen.getByTitle(/^(错误|Error)$/).textContent).toBe("1");
  });

  it("右键菜单提供同一密度切换动作", async () => {
    const user = userEvent.setup();
    renderBar();

    fireEvent.contextMenu(screen.getByRole("tab", { name: /布局 1/ }));
    await user.click(await screen.findByRole("menuitem", { name: /切换到紧凑档|Switch to compact/i }));

    expect(useLayoutUiStore.getState().layoutBarDensity).toBe("compact");
  });
});
