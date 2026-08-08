import "@/i18n";
import i18n from "i18next";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Panel as PanelType, Tab } from "@/types";
import {
  useDialogStore,
  useFullscreenStore,
  usePanesStore,
  useSshMachineDialogStore,
  useWorkspacesStore,
} from "@/stores";
import { terminalService } from "@/services";
import Panel from "./Panel";
import { CLOSE_ACTIVE_TAB_EVENT } from "./useTabClosing";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";

interface TabBarProps {
  tabs: Tab[];
  activeId: string;
  onClose: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onEditWorkspaceEnvironment?: (tab: Tab) => void;
  canEditWorkspaceEnvironment?: (tab: Tab) => boolean;
  onAddSsh?: () => void;
}

let tabBarProps: TabBarProps | null = null;

vi.mock("./TabBar", () => ({
  default: (props: TabBarProps) => {
    tabBarProps = props;
    return <div data-testid="tab-bar" />;
  },
}));

interface TabContentProps {
  tab: Tab;
  isVisible: boolean;
  showTerminalStatusBar?: boolean;
  onSessionExited?: (exitCode: number, terminalPaneId?: string) => void;
}

const tabContentPropsByTab = new Map<string, TabContentProps>();

vi.mock("./TabContentRenderer", () => ({
  default: (props: TabContentProps) => {
    tabContentPropsByTab.set(props.tab.id, props);
    return <div data-testid={`tab-content-${props.tab.id}`} />;
  },
}));

// 回收管线在 kill 之前会先 detach 全部会话（阶段 1）——mock 缺了这两个方法
// 会让管线在第一阶段就抛错中断，表现为「killSession 没被调用」，看着像功能
// 坏了，其实是观察点不全。
vi.mock("@/services/terminalService", () => ({
  terminalService: {
    killSession: vi.fn().mockResolvedValue(undefined),
    detachOutput: vi.fn(),
    detachExit: vi.fn(),
  },
}));

vi.mock("@/services/popupWindowService", () => ({
  popOutTab: vi.fn(),
  isTabPoppedOut: vi.fn(() => false),
  markTabReclaimed: vi.fn(),
  getPoppedTabs: vi.fn(() => []),
}));

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const killSession = vi.mocked(terminalService.killSession);

function makeTab(id: string, overrides?: Partial<Tab>): Tab {
  return {
    id,
    title: id,
    contentType: "terminal",
    projectId: "proj-1",
    projectPath: "/tmp/proj",
    sessionId: null,
    terminalRootPane: { type: "leaf", id: `leaf-${id}`, sessionId: `sess-${id}` },
    activeTerminalPaneId: `leaf-${id}`,
    ...overrides,
  } as Tab;
}

function makePane(tabs: Tab[], activeTabId = tabs[0]?.id ?? ""): PanelType {
  return { type: "panel", id: "pane-1", tabs, activeTabId };
}

function setPanesState(pane: PanelType, overrides?: Record<string, unknown>) {
  // layouts 必须给一条真实条目：B1-04 起关闭走 removeTabsInternal，它跨全部
  // 布局定位目标 tab（星标布局里的标签同样要能关）。空 layouts 会让它一个
  // tab 都找不到，表现为「点了没反应」。
  usePanesStore.setState({
    activePaneId: pane.id,
    rootPane: pane,
    allPanels: () => [pane],
    layouts: [
      {
        id: "layout-1",
        name: "布局 1",
        kind: "normal",
        rootPane: pane,
        activePaneId: pane.id,
      },
    ],
    currentLayoutId: "layout-1",
    closedTabs: [],
    poppedOutTabs: new Set<string>(),
    isTabPoppedOut: () => false,
    ...overrides,
  } as never);
}

/**
 * 关闭路径的观察点。
 *
 * B1-04 起 UI 不再自己 kill、也不调 closeTab —— 回收与树操作统一交给
 * removeTabsInternal（唯一销毁出口）。所以断言打在「出口收到了哪些 tabId
 * 与什么 reason」上，而不是旧的 closeTab + killSession 组合。
 */
function spyRemoveTabs() {
  const spy = vi.fn();
  usePanesStore.setState({ removeTabsInternal: spy } as never);
  return spy;
}

const tRaw = i18n.t as (key: string, options?: Record<string, unknown>) => string;
function tPanes(key: string, options?: Record<string, unknown>) {
  return tRaw(key, { ns: "panes", ...options });
}

describe("Panel", () => {
  beforeEach(() => {
    useFullscreenStore.setState({ isFullscreen: false, fullscreenPaneId: null } as never);
    useSshMachineDialogStore.setState({ addDialogOpen: false });
    useWorkspacesStore.setState({ workspaces: [] } as never);
  });

  afterEach(() => {
    tabBarProps = null;
    tabContentPropsByTab.clear();
    vi.clearAllMocks();
  });

  it("renders every tab's content but only shows the active one", () => {
    const pane = makePane([makeTab("t1"), makeTab("t2")], "t1");
    setPanesState(pane);

    render(<Panel pane={pane} />);

    const t1 = screen.getByTestId("tab-content-t1").parentElement!;
    const t2 = screen.getByTestId("tab-content-t2").parentElement!;
    expect(t1.style.display).toBe("flex");
    expect(t2.style.display).toBe("none");
    // 可见性不再走 props：断言单源里的 primary 视图条目（真实写侧
    // useReportPaneVisibility 在 Panel 内挂载）
    const viewOf = (owner: string) =>
      useTabViewStateStore.getState().getViewVisibility(owner, "primary");
    expect(viewOf("t1")).not.toBe("hidden");
    expect(viewOf("t2")).toBe("hidden");
  });

  it("requests the add-machine dialog from the new SSH action", () => {
    const pane = makePane([makeTab("t1")]);
    setPanesState(pane);
    render(<Panel pane={pane} />);

    act(() => {
      tabBarProps?.onAddSsh?.();
    });

    expect(useSshMachineDialogStore.getState().addDialogOpen).toBe(true);
  });

  it("enables terminal status bars only when the layout has multiple panes", () => {
    const pane = makePane([makeTab("t1")]);
    const otherPane: PanelType = {
      type: "panel",
      id: "pane-2",
      tabs: [makeTab("t2")],
      activeTabId: "t2",
    };
    setPanesState(pane, {
      rootPane: {
        type: "split",
        id: "root-split",
        direction: "horizontal",
        sizes: [50, 50],
        children: [pane, otherPane],
      },
    });

    render(<Panel pane={pane} />);

    expect(tabContentPropsByTab.get("t1")?.showTerminalStatusBar).toBe(true);
  });

  it("shows the empty state when the active tab has no project", () => {
    const pane = makePane([makeTab("t1", { projectPath: "", terminalRootPane: undefined })]);
    setPanesState(pane);

    render(<Panel pane={pane} />);

    expect(screen.getByText(tPanes("ready"))).toBeInTheDocument();
    expect(screen.getByText(tPanes("selectProject"))).toBeInTheDocument();
  });

  it("does not cover a browser tab with the empty terminal state", () => {
    const pane = makePane([
      makeTab("browser-1", {
        contentType: "browser",
        projectPath: "",
        browserUrl: "http://localhost:5173/",
        terminalRootPane: undefined,
      }),
    ]);
    setPanesState(pane);

    render(<Panel pane={pane} />);

    expect(screen.queryByText(tPanes("selectProject"))).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-content-browser-1")).toBeInTheDocument();
  });

  it("把整个 tab 交给销毁出口（分屏会话由出口全量回收）", () => {
    const pane = makePane([
      makeTab("t1", {
        terminalRootPane: {
          type: "split",
          id: "split-1",
          direction: "horizontal",
          sizes: [50, 50],
          children: [
            { type: "leaf", id: "leaf-a", sessionId: "sess-a" },
            { type: "leaf", id: "leaf-b", sessionId: "sess-b" },
          ],
        } as Tab["terminalRootPane"],
      }),
    ]);
    setPanesState(pane);
    const removeTabs = spyRemoveTabs();

    render(<Panel pane={pane} />);
    tabBarProps!.onClose("t1");

    expect(removeTabs).toHaveBeenCalledWith(["t1"], "user-close");
  });

  it("ignores close requests for pinned tabs", () => {
    const pane = makePane([makeTab("t1", { pinned: true })]);
    setPanesState(pane);
    const removeTabs = spyRemoveTabs();

    render(<Panel pane={pane} />);
    tabBarProps!.onClose("t1");

    expect(removeTabs).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
  });

  it("asks for confirmation before closing a dirty tab and closes on confirm", async () => {
    const user = userEvent.setup();
    const pane = makePane([makeTab("t1", { dirty: true })]);
    setPanesState(pane);
    const removeTabs = spyRemoveTabs();

    render(<Panel pane={pane} />);
    tabBarProps!.onClose("t1");

    expect(await screen.findByText(tPanes("closeTabConfirmTitle"))).toBeInTheDocument();
    expect(removeTabs).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: tPanes("closeTabConfirmAction") }));

    expect(removeTabs).toHaveBeenCalledWith(["t1"], "user-close");
  });

  it("cancelling the dirty confirm keeps the tab open", async () => {
    const user = userEvent.setup();
    const pane = makePane([makeTab("t1", { dirty: true })]);
    setPanesState(pane);
    const removeTabs = spyRemoveTabs();

    render(<Panel pane={pane} />);
    tabBarProps!.onClose("t1");
    await screen.findByText(tPanes("closeTabConfirmTitle"));

    await user.click(screen.getByRole("button", { name: i18n.t("cancel") }));

    expect(removeTabs).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
  });

  it("批量关闭把未 pinned 的其余 tab 交给出口，pinned 与目标不动", () => {
    const pane = makePane([makeTab("keep"), makeTab("x"), makeTab("pinned", { pinned: true })], "keep");
    setPanesState(pane);
    const removeTabs = spyRemoveTabs();

    render(<Panel pane={pane} />);
    tabBarProps!.onCloseOtherTabs("keep");

    expect(removeTabs).toHaveBeenCalledWith(["x"], "batch-close");
  });

  it("shows the batch confirm with dirty count and applies the batch close on confirm", async () => {
    const user = userEvent.setup();
    const pane = makePane([makeTab("keep"), makeTab("d1", { dirty: true }), makeTab("d2", { dirty: true })], "keep");
    setPanesState(pane);
    const removeTabs = spyRemoveTabs();

    render(<Panel pane={pane} />);
    tabBarProps!.onCloseOtherTabs("keep");

    expect(await screen.findByText(tPanes("closeTabDirtyEditors", { count: 2 }))).toBeInTheDocument();
    expect(removeTabs).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: tPanes("closeTabConfirmAction") }));

    expect(removeTabs).toHaveBeenCalledWith(["d1", "d2"], "batch-close");
  });

  // close-tab 快捷键（Ctrl+W）派发 CLOSE_ACTIVE_TAB_EVENT，必须与鼠标点 × 同路径
  describe("close-tab 快捷键", () => {
    function fireCloseShortcut() {
      fireEvent(window, new Event(CLOSE_ACTIVE_TAB_EVENT));
    }

    it("与鼠标点 × 同路径：整个 tab 交给销毁出口（分屏会话由出口全量回收）", () => {
      const pane = makePane([
        makeTab("t1", {
          sessionId: "sess-a",
          terminalRootPane: {
            type: "split",
            id: "split-1",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              { type: "leaf", id: "leaf-a", sessionId: "sess-a" },
              { type: "leaf", id: "leaf-b", sessionId: "sess-b" },
            ],
          } as Tab["terminalRootPane"],
        }),
      ]);
      setPanesState(pane);
      const removeTabs = spyRemoveTabs();

      render(<Panel pane={pane} />);
      fireCloseShortcut();

      expect(removeTabs).toHaveBeenCalledWith(["t1"], "user-close");
    });

    it("does not close a pinned tab", () => {
      const pane = makePane([makeTab("t1", { pinned: true })]);
      setPanesState(pane);
      const removeTabs = spyRemoveTabs();

      render(<Panel pane={pane} />);
      fireCloseShortcut();

      expect(removeTabs).not.toHaveBeenCalled();
      expect(killSession).not.toHaveBeenCalled();
    });

    it("asks for confirmation on a dirty tab instead of closing it silently", async () => {
      const user = userEvent.setup();
      const pane = makePane([makeTab("t1", { dirty: true })]);
      setPanesState(pane);
      const removeTabs = spyRemoveTabs();

      render(<Panel pane={pane} />);
      fireCloseShortcut();

      expect(await screen.findByText(tPanes("closeTabConfirmTitle"))).toBeInTheDocument();
      expect(removeTabs).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: tPanes("closeTabConfirmAction") }));

      expect(removeTabs).toHaveBeenCalledWith(["t1"], "user-close");
    });

    it("is ignored by panels that are not the active pane", () => {
      const closeTab = vi.fn();
      const pane = makePane([makeTab("t1")]);
      setPanesState(pane, { closeTab, activePaneId: "pane-other" });

      render(<Panel pane={pane} />);
      fireCloseShortcut();

      expect(closeTab).not.toHaveBeenCalled();
      expect(killSession).not.toHaveBeenCalled();
    });
  });

  it("activates its pane when clicked", () => {
    const setActivePane = vi.fn();
    const pane = makePane([makeTab("t1")]);
    setPanesState(pane, { setActivePane });

    const { container } = render(<Panel pane={pane} />);
    fireEvent.click(container.querySelector("[data-pane-id='pane-1']")!);

    expect(setActivePane).toHaveBeenCalledWith("pane-1");
  });

  it("marks only ssh tabs disconnected when their session exits", () => {
    const setTabDisconnected = vi.fn();
    const sshTab = makeTab("ssh-tab", { ssh: { host: "example" } as Tab["ssh"] });
    const localTab = makeTab("local-tab");
    const pane = makePane([sshTab, localTab], "ssh-tab");
    setPanesState(pane, { setTabDisconnected });

    render(<Panel pane={pane} />);
    tabContentPropsByTab.get("ssh-tab")!.onSessionExited?.(1, "leaf-ssh-tab");
    tabContentPropsByTab.get("local-tab")!.onSessionExited?.(0, "leaf-local-tab");

    expect(setTabDisconnected).toHaveBeenCalledTimes(1);
    expect(setTabDisconnected).toHaveBeenCalledWith("pane-1", "ssh-tab", true, "leaf-ssh-tab");
  });

  it("resolves workspace environment editing by tab workspace name", () => {
    const openWorkspaceEnvironment = vi.fn();
    useDialogStore.setState({ openWorkspaceEnvironment } as never);
    useWorkspacesStore.setState({
      workspaces: [{ id: "ws-1", name: "alpha", path: "/ws", projects: [] }],
    } as never);
    const tab = makeTab("t1", { workspaceName: "alpha" });
    const pane = makePane([tab]);
    setPanesState(pane);

    render(<Panel pane={pane} />);

    expect(tabBarProps!.canEditWorkspaceEnvironment?.(tab)).toBe(true);
    tabBarProps!.onEditWorkspaceEnvironment?.(tab);
    expect(openWorkspaceEnvironment).toHaveBeenCalledWith("ws-1");

    const orphan = makeTab("t2", { projectPath: "/elsewhere" });
    expect(tabBarProps!.canEditWorkspaceEnvironment?.(orphan)).toBe(false);
  });

  it("matches a workspace by normalized project path when no workspace name is set", () => {
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: "ws-2",
          name: "beta",
          path: "/other",
          projects: [{ path: "C:\\Repos\\Proj\\" }],
        },
      ],
    } as never);
    const tab = makeTab("t1", { projectPath: "c:/repos/proj" });
    const pane = makePane([tab]);
    setPanesState(pane);

    render(<Panel pane={pane} />);

    expect(tabBarProps!.canEditWorkspaceEnvironment?.(tab)).toBe(true);
  });

  it("exits fullscreen with Escape when this panel is fullscreen", () => {
    const exitFullscreen = vi.fn();
    useFullscreenStore.setState({
      isFullscreen: true,
      fullscreenPaneId: "pane-1",
      exitFullscreen,
    } as never);
    const pane = makePane([makeTab("t1")]);
    setPanesState(pane);

    render(<Panel pane={pane} />);

    expect(screen.getByText("ESC")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape when another panel is fullscreen", () => {
    const exitFullscreen = vi.fn();
    useFullscreenStore.setState({
      isFullscreen: true,
      fullscreenPaneId: "pane-other",
      exitFullscreen,
    } as never);
    const pane = makePane([makeTab("t1")]);
    setPanesState(pane);

    render(<Panel pane={pane} />);

    expect(screen.queryByText("ESC")).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(exitFullscreen).not.toHaveBeenCalled();
  });
});
