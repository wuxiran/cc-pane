import i18n from "@/i18n";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { useQuickCommandsStore } from "@/stores";
import TabBar from "./TabBar";
import type { QuickCommand, Tab } from "@/types";

const executeQuickCommand = vi.fn();

vi.mock("@/lib/quickCommandExecution", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/quickCommandExecution")>();
  return {
    ...original,
    executeQuickCommand: (...args: unknown[]) => executeQuickCommand(...args),
  };
});

const scrollIntoViewMock = vi.fn();

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: scrollIntoViewMock,
});

function makeTab(id: string, title: string): Tab {
  return {
    id,
    title,
    contentType: "terminal",
    projectId: "proj-1",
    projectPath: "/tmp/proj1",
    sessionId: null,
    terminalRootPane: {
      type: "leaf",
      id: `terminal-pane-${id}`,
      sessionId: null,
    },
    activeTerminalPaneId: `terminal-pane-${id}`,
  };
}

function quickCommand(overrides: Partial<QuickCommand> = {}): QuickCommand {
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

function renderTabBar({
  tabs = [makeTab("tab-1", "Alpha")],
  activeId = tabs[0]?.id ?? "",
  onRename = vi.fn(),
  onFullscreen = vi.fn(),
  layoutMoveTargets = [],
  onMoveTabToLayoutPane = vi.fn(),
  onEditWorkspaceEnvironment,
  canEditWorkspaceEnvironment,
  onCloneTab,
  onToggleFullscreen,
  isPaneFullscreen,
  onAddSsh,
}: {
  tabs?: Tab[];
  activeId?: string;
  onRename?: (tabId: string, newTitle: string) => void;
  onFullscreen?: (tabId: string) => void;
  layoutMoveTargets?: { id: string; label: string; panes: { id: string; label: string }[] }[];
  onMoveTabToLayoutPane?: (tabId: string, targetLayoutId: string, targetPaneId: string) => void;
  onEditWorkspaceEnvironment?: (tab: Tab) => void;
  canEditWorkspaceEnvironment?: (tab: Tab) => boolean;
  onCloneTab?: (tab: Tab) => void;
  onToggleFullscreen?: (tabId: string) => void;
  isPaneFullscreen?: boolean;
  onAddSsh?: () => void;
} = {}) {
  return render(
    <DndContext>
      <TabBar
        paneId="pane-1"
        tabs={tabs}
        activeId={activeId}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onTogglePin={vi.fn()}
        onToggleStar={vi.fn()}
        newTab={{ onAdd: vi.fn(), onAddSsh }}
        onSplitRight={vi.fn()}
        onSplitDown={vi.fn()}
        onFullscreen={onFullscreen}
        onRename={onRename}
        onSplitAndMoveRight={vi.fn()}
        onSplitAndMoveDown={vi.fn()}
        moveTargets={[]}
        onMoveTabToPane={vi.fn()}
        layoutMoveTargets={layoutMoveTargets}
        onMoveTabToLayoutPane={onMoveTabToLayoutPane}
        onSplitTerminalRight={vi.fn()}
        onSplitTerminalDown={vi.fn()}
        onCloseTerminalPane={vi.fn()}
        onCloseTabsToLeft={vi.fn()}
        onCloseTabsToRight={vi.fn()}
        onCloseOtherTabs={vi.fn()}
        onEditWorkspaceEnvironment={onEditWorkspaceEnvironment}
        canEditWorkspaceEnvironment={canEditWorkspaceEnvironment}
        onCloneTab={onCloneTab}
        onToggleFullscreen={onToggleFullscreen}
        isPaneFullscreen={isPaneFullscreen}
      />
    </DndContext>
  );
}

describe("TabBar", () => {
  beforeEach(() => {
    executeQuickCommand.mockReset();
    executeQuickCommand.mockResolvedValue(undefined);
    useQuickCommandsStore.setState({ commands: [], activeProjectPath: null });
  });

  afterEach(() => {
    scrollIntoViewMock.mockReset();
    vi.restoreAllMocks();
  });

  it("opens the SSH manager from the new-tab menu", async () => {
    const user = userEvent.setup();
    const onAddSsh = vi.fn();
    renderTabBar({ onAddSsh });

    await user.click(screen.getByRole("button", { name: i18n.t("panes:newTabMenu") }));
    await user.click(await screen.findByRole("menuitem", { name: i18n.t("panes:newSshTab") }));

    expect(onAddSsh).toHaveBeenCalledOnce();
  });

  it("右键重命名后应进入编辑态并提交新标题", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    renderTabBar({ onRename });

    fireEvent.contextMenu(screen.getByText("Alpha"));

    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));

    const input = await screen.findByDisplayValue("Alpha");
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.blur(input);
    expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument();
    expect(onRename).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "Beta{enter}");

    expect(onRename).toHaveBeenCalledWith("tab-1", "Beta");
  });

  it("重命名时点击输入框外应确认并退出编辑态", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    renderTabBar({ onRename });

    fireEvent.contextMenu(screen.getByText("Alpha"));
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));

    const input = await screen.findByDisplayValue("Alpha");
    await waitFor(() => expect(input).toHaveFocus());
    await user.clear(input);
    await user.type(input, "Outside");
    await user.click(screen.getByRole("button", { name: String(i18n.t("panes:newTab")) }));

    expect(onRename).toHaveBeenCalledWith("tab-1", "Outside");
    expect(screen.queryByDisplayValue("Outside")).not.toBeInTheDocument();
  });

  it("双击标题后应进入编辑态，且不触发全屏", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onFullscreen = vi.fn();
    renderTabBar({ onRename, onFullscreen });

    await user.dblClick(screen.getByText("Alpha"));

    const input = await screen.findByDisplayValue("Alpha");
    await user.clear(input);
    await user.type(input, "Gamma{enter}");

    expect(onFullscreen).not.toHaveBeenCalled();
    expect(onRename).toHaveBeenCalledWith("tab-1", "Gamma");
  });

  it("opens the workspace environment editor from a tab context menu", async () => {
    const user = userEvent.setup();
    const tab = {
      ...makeTab("tab-1", "Alpha"),
      workspaceName: "workspace-alpha",
    };
    const onEditWorkspaceEnvironment = vi.fn();
    renderTabBar({
      tabs: [tab],
      onEditWorkspaceEnvironment,
      canEditWorkspaceEnvironment: () => true,
    });

    fireEvent.contextMenu(screen.getByText("Alpha"));
    await user.click(await screen.findByRole("menuitem", { name: /编辑运行环境|Edit Environment/i }));

    expect(onEditWorkspaceEnvironment).toHaveBeenCalledWith(tab);
  });

  it("克隆终端菜单项应回传整个 tab", async () => {
    const user = userEvent.setup();
    const tab = makeTab("tab-1", "Alpha");
    const onCloneTab = vi.fn();
    renderTabBar({ tabs: [tab], onCloneTab });

    fireEvent.contextMenu(screen.getByText("Alpha"));
    await user.click(await screen.findByRole("menuitem", { name: /克隆终端|Clone Terminal/i }));

    expect(onCloneTab).toHaveBeenCalledWith(tab);
  });

  it("快捷命令子菜单禁用无会话的当前 pane 命令并执行可用命令", async () => {
    const user = userEvent.setup();
    const tab = makeTab("tab-1", "Alpha");
    const current = quickCommand({ id: "current", name: "Current command" });
    const newTab = quickCommand({ id: "new", name: "New tab command", target: "newTab" });
    const invalidAgent = quickCommand({
      id: "invalid-agent",
      name: "Invalid agent",
      kind: "agentPrompt",
      target: "newTab",
      cliTool: "none",
    });
    useQuickCommandsStore.setState({
      activeProjectPath: tab.projectPath,
      commands: [
        { ...current, scope: "global" },
        { ...newTab, scope: "project" },
        { ...invalidAgent, scope: "global" },
      ],
    });
    renderTabBar({ tabs: [tab] });

    fireEvent.contextMenu(screen.getByText("Alpha"));
    const trigger = await screen.findByText(/运行快捷命令|Run Quick Command/i);
    await user.hover(trigger);

    const currentItem = await screen.findByRole("menuitem", { name: /Current command/ });
    const newTabItem = await screen.findByRole("menuitem", { name: /New tab command/ });
    const invalidAgentItem = await screen.findByRole("menuitem", { name: /Invalid agent/ });
    expect(currentItem).toHaveAttribute("aria-disabled", "true");
    expect(newTabItem).not.toHaveAttribute("aria-disabled", "true");
    expect(invalidAgentItem).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(newTabItem);

    expect(executeQuickCommand).toHaveBeenCalledWith(newTab, {
      paneId: "pane-1",
      tab,
    });
  });

  it("右键标签不显示其他项目的项目级快捷命令", async () => {
    const user = userEvent.setup();
    const tab = makeTab("tab-1", "Alpha");
    useQuickCommandsStore.setState({
      activeProjectPath: "/tmp/other-project",
      commands: [
        { ...quickCommand({ id: "global", name: "Global command" }), scope: "global" },
        { ...quickCommand({ id: "project", name: "Other project command" }), scope: "project" },
      ],
    });
    renderTabBar({ tabs: [tab] });

    fireEvent.contextMenu(screen.getByText("Alpha"));
    await user.hover(await screen.findByText(/运行快捷命令|Run Quick Command/i));

    expect(await screen.findByRole("menuitem", { name: /Global command/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Other project command/ })).not.toBeInTheDocument();
  });

  it("无 projectPath 的标签不显示克隆终端", async () => {
    const tab = { ...makeTab("tab-1", "Alpha"), projectPath: "" };
    renderTabBar({ tabs: [tab], onCloneTab: vi.fn() });

    fireEvent.contextMenu(screen.getByText("Alpha"));

    await screen.findByRole("menuitem", { name: /重命名|Rename/i });
    expect(
      screen.queryByRole("menuitem", { name: /克隆终端|Clone Terminal/i })
    ).not.toBeInTheDocument();
  });

  it("全屏切换菜单项按当前状态显示进入/退出并触发回调", async () => {
    const user = userEvent.setup();
    const onToggleFullscreen = vi.fn();
    const view = renderTabBar({ onToggleFullscreen, isPaneFullscreen: false });

    fireEvent.contextMenu(screen.getByText("Alpha"));
    await user.click(await screen.findByRole("menuitem", { name: /进入全屏|Enter Full Screen/i }));
    expect(onToggleFullscreen).toHaveBeenCalledWith("tab-1");

    view.unmount();
    renderTabBar({ onToggleFullscreen, isPaneFullscreen: true });
    fireEvent.contextMenu(screen.getByText("Alpha"));
    expect(
      await screen.findByRole("menuitem", { name: /退出全屏|Exit Full Screen/i })
    ).toBeInTheDocument();
  });

  it("shows layout move targets in the tab context menu", async () => {
    renderTabBar({
      layoutMoveTargets: [{
        id: "layout-2",
        label: "布局 2",
        panes: [{ id: "pane-2", label: "窗格 1 · Beta" }],
      }],
    });

    fireEvent.contextMenu(screen.getByText("Alpha"));

    expect(await screen.findByText("发送到布局")).toBeInTheDocument();
  });

  it("uses a horizontally scrollable max-content tab strip for overflow", () => {
    renderTabBar({
      tabs: [
        makeTab("tab-1", "Alpha"),
        makeTab("tab-2", "Beta"),
        makeTab("tab-3", "Gamma"),
        makeTab("tab-4", "Delta"),
      ],
    });

    const scrollContainer = screen.getByTestId("pane-tabbar-scroll");
    const itemsContainer = screen.getByTestId("pane-tabbar-items");

    expect(scrollContainer.className).toContain("overflow-x-auto");
    expect(scrollContainer.className).toContain("cc-tabbar-scroll");
    expect(scrollContainer.className).not.toContain("no-scrollbar");
    expect(itemsContainer.className).toContain("inline-flex");
    expect(itemsContainer.className).toContain("min-w-max");
    expect(itemsContainer.className).not.toContain("flex-1");
  });

  it("maps mouse wheel movement to horizontal tab scrolling", () => {
    renderTabBar({
      tabs: [
        makeTab("tab-1", "Alpha"),
        makeTab("tab-2", "Beta"),
        makeTab("tab-3", "Gamma"),
        makeTab("tab-4", "Delta"),
      ],
    });

    const scrollContainer = screen.getByTestId("pane-tabbar-scroll");
    Object.defineProperty(scrollContainer, "clientWidth", { configurable: true, value: 120 });
    Object.defineProperty(scrollContainer, "scrollWidth", { configurable: true, value: 420 });
    scrollContainer.scrollLeft = 0;

    fireEvent.wheel(scrollContainer, { deltaY: 80 });

    expect(scrollContainer.scrollLeft).toBe(80);
  });

  it("scrolls the active tab into view when the active tab changes", () => {
    const scrollCalls: string[] = [];
    scrollIntoViewMock.mockImplementation(function mockScrollIntoView(this: HTMLElement) {
      scrollCalls.push(this.dataset.tabId ?? "");
    });

    const tabs = [
      makeTab("tab-1", "Alpha"),
      makeTab("tab-2", "Beta"),
      makeTab("tab-3", "Gamma"),
    ];

    const view = renderTabBar({ tabs, activeId: "tab-1" });
    scrollCalls.length = 0;

    view.rerender(
      <DndContext>
        <TabBar
          paneId="pane-1"
          tabs={tabs}
          activeId="tab-3"
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onTogglePin={vi.fn()}
          onToggleStar={vi.fn()}
          newTab={{ onAdd: vi.fn() }}
          onSplitRight={vi.fn()}
          onSplitDown={vi.fn()}
          onFullscreen={vi.fn()}
          onRename={vi.fn()}
          onSplitAndMoveRight={vi.fn()}
          onSplitAndMoveDown={vi.fn()}
          moveTargets={[]}
          onMoveTabToPane={vi.fn()}
          layoutMoveTargets={[]}
          onMoveTabToLayoutPane={vi.fn()}
          onSplitTerminalRight={vi.fn()}
          onSplitTerminalDown={vi.fn()}
          onCloseTerminalPane={vi.fn()}
          onCloseTabsToLeft={vi.fn()}
          onCloseTabsToRight={vi.fn()}
          onCloseOtherTabs={vi.fn()}
        />
      </DndContext>
    );

    expect(scrollCalls).toContain("tab-3");
  });
});
