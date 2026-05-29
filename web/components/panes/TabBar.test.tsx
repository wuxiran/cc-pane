import "@/i18n";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import TabBar from "./TabBar";
import type { Tab } from "@/types";

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

function renderTabBar({
  tabs = [makeTab("tab-1", "Alpha")],
  activeId = tabs[0]?.id ?? "",
  onRename = vi.fn(),
  onFullscreen = vi.fn(),
  onEditWorkspaceEnvironment,
  canEditWorkspaceEnvironment,
}: {
  tabs?: Tab[];
  activeId?: string;
  onRename?: (tabId: string, newTitle: string) => void;
  onFullscreen?: (tabId: string) => void;
  onEditWorkspaceEnvironment?: (tab: Tab) => void;
  canEditWorkspaceEnvironment?: (tab: Tab) => boolean;
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
        onAdd={vi.fn()}
        onSplitRight={vi.fn()}
        onSplitDown={vi.fn()}
        onFullscreen={onFullscreen}
        onRename={onRename}
        onSplitAndMoveRight={vi.fn()}
        onSplitAndMoveDown={vi.fn()}
        onSplitTerminalRight={vi.fn()}
        onSplitTerminalDown={vi.fn()}
        onCloseTerminalPane={vi.fn()}
        onCloseTabsToLeft={vi.fn()}
        onCloseTabsToRight={vi.fn()}
        onCloseOtherTabs={vi.fn()}
        onEditWorkspaceEnvironment={onEditWorkspaceEnvironment}
        canEditWorkspaceEnvironment={canEditWorkspaceEnvironment}
      />
    </DndContext>
  );
}

describe("TabBar", () => {
  afterEach(() => {
    scrollIntoViewMock.mockReset();
    vi.restoreAllMocks();
  });

  it("右键重命名后应进入编辑态并提交新标题", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    renderTabBar({ onRename });

    fireEvent.contextMenu(screen.getByText("Alpha"));

    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));

    const input = await screen.findByDisplayValue("Alpha");
    await user.clear(input);
    await user.type(input, "Beta{enter}");

    expect(onRename).toHaveBeenCalledWith("tab-1", "Beta");
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
          onAdd={vi.fn()}
          onSplitRight={vi.fn()}
          onSplitDown={vi.fn()}
          onFullscreen={vi.fn()}
          onRename={vi.fn()}
          onSplitAndMoveRight={vi.fn()}
          onSplitAndMoveDown={vi.fn()}
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
