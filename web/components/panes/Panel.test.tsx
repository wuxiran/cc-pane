import "@/i18n";
import i18n from "i18next";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Panel as PanelType, Tab } from "@/types";
import {
  useDialogStore,
  useFullscreenStore,
  usePanesStore,
  useWorkspacesStore,
} from "@/stores";
import { terminalService } from "@/services";
import Panel from "./Panel";

interface TabBarProps {
  tabs: Tab[];
  activeId: string;
  onClose: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onEditWorkspaceEnvironment?: (tab: Tab) => void;
  canEditWorkspaceEnvironment?: (tab: Tab) => boolean;
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
  onSessionExited?: (exitCode: number, terminalPaneId?: string) => void;
}

const tabContentPropsByTab = new Map<string, TabContentProps>();

vi.mock("./TabContentRenderer", () => ({
  default: (props: TabContentProps) => {
    tabContentPropsByTab.set(props.tab.id, props);
    return <div data-testid={`tab-content-${props.tab.id}`} />;
  },
}));

vi.mock("@/services/terminalService", () => ({
  terminalService: { killSession: vi.fn().mockResolvedValue(undefined) },
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
  usePanesStore.setState({
    activePaneId: pane.id,
    rootPane: pane,
    allPanels: () => [pane],
    layouts: [],
    currentLayoutId: "layout-1",
    isTabPoppedOut: () => false,
    ...overrides,
  } as never);
}

const tRaw = i18n.t as (key: string, options?: Record<string, unknown>) => string;
function tPanes(key: string, options?: Record<string, unknown>) {
  return tRaw(key, { ns: "panes", ...options });
}

describe("Panel", () => {
  beforeEach(() => {
    useFullscreenStore.setState({ isFullscreen: false, fullscreenPaneId: null } as never);
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
    expect(tabContentPropsByTab.get("t1")?.isVisible).toBe(true);
    expect(tabContentPropsByTab.get("t2")?.isVisible).toBe(false);
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

  it("kills all terminal sessions of a tab and closes it", () => {
    const closeTab = vi.fn();
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
    setPanesState(pane, { closeTab });

    render(<Panel pane={pane} />);
    tabBarProps!.onClose("t1");

    expect(killSession).toHaveBeenCalledWith("sess-a");
    expect(killSession).toHaveBeenCalledWith("sess-b");
    expect(closeTab).toHaveBeenCalledWith("pane-1", "t1");
  });

  it("ignores close requests for pinned tabs", () => {
    const closeTab = vi.fn();
    const pane = makePane([makeTab("t1", { pinned: true })]);
    setPanesState(pane, { closeTab });

    render(<Panel pane={pane} />);
    tabBarProps!.onClose("t1");

    expect(closeTab).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
  });

  it("asks for confirmation before closing a dirty tab and closes on confirm", async () => {
    const user = userEvent.setup();
    const closeTab = vi.fn();
    const pane = makePane([makeTab("t1", { dirty: true })]);
    setPanesState(pane, { closeTab });

    render(<Panel pane={pane} />);
    tabBarProps!.onClose("t1");

    expect(await screen.findByText(tPanes("unsavedChanges"))).toBeInTheDocument();
    expect(closeTab).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: tPanes("discardAndClose") }));

    expect(closeTab).toHaveBeenCalledWith("pane-1", "t1");
    expect(killSession).toHaveBeenCalledWith("sess-t1");
  });

  it("cancelling the dirty confirm keeps the tab open", async () => {
    const user = userEvent.setup();
    const closeTab = vi.fn();
    const pane = makePane([makeTab("t1", { dirty: true })]);
    setPanesState(pane, { closeTab });

    render(<Panel pane={pane} />);
    tabBarProps!.onClose("t1");
    await screen.findByText(tPanes("unsavedChanges"));

    await user.click(screen.getByRole("button", { name: i18n.t("cancel") }));

    expect(closeTab).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
  });

  it("closes other tabs directly when none are dirty, sparing pinned tabs' sessions", () => {
    const closeOtherTabs = vi.fn();
    const pane = makePane([makeTab("keep"), makeTab("x"), makeTab("pinned", { pinned: true })], "keep");
    setPanesState(pane, { closeOtherTabs });

    render(<Panel pane={pane} />);
    tabBarProps!.onCloseOtherTabs("keep");

    expect(killSession).toHaveBeenCalledWith("sess-x");
    expect(killSession).not.toHaveBeenCalledWith("sess-pinned");
    expect(killSession).not.toHaveBeenCalledWith("sess-keep");
    expect(closeOtherTabs).toHaveBeenCalledWith("pane-1", "keep");
  });

  it("shows the batch confirm with dirty count and applies the batch close on confirm", async () => {
    const user = userEvent.setup();
    const closeOtherTabs = vi.fn();
    const pane = makePane([makeTab("keep"), makeTab("d1", { dirty: true }), makeTab("d2", { dirty: true })], "keep");
    setPanesState(pane, { closeOtherTabs });

    render(<Panel pane={pane} />);
    tabBarProps!.onCloseOtherTabs("keep");

    expect(await screen.findByText(tPanes("unsavedTabsCount", { count: 2 }))).toBeInTheDocument();
    expect(closeOtherTabs).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: tPanes("discardAndClose") }));

    expect(closeOtherTabs).toHaveBeenCalledWith("pane-1", "keep");
    expect(killSession).toHaveBeenCalledWith("sess-d1");
    expect(killSession).toHaveBeenCalledWith("sess-d2");
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
