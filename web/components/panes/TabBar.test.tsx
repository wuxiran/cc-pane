import "@/i18n";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import TabBar from "./TabBar";
import type { Tab } from "@/types";

function renderTabBar(onRename = vi.fn()) {
  const tab: Tab = {
    id: "tab-1",
    title: "Alpha",
    contentType: "terminal",
    projectId: "proj-1",
    projectPath: "/tmp/proj1",
    sessionId: null,
    terminalRootPane: {
      type: "leaf",
      id: "terminal-pane-1",
      sessionId: null,
    },
    activeTerminalPaneId: "terminal-pane-1",
  };

  render(
    <DndContext>
      <TabBar
        paneId="pane-1"
        tabs={[tab]}
        activeId={tab.id}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onTogglePin={vi.fn()}
        onAdd={vi.fn()}
        onSplitRight={vi.fn()}
        onSplitDown={vi.fn()}
        onFullscreen={vi.fn()}
        onRename={onRename}
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

  return tab;
}

describe("TabBar", () => {
  it("右键重命名后应进入编辑态并提交新标题", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    renderTabBar(onRename);

    fireEvent.contextMenu(screen.getByText("Alpha"));

    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));

    const input = await screen.findByDisplayValue("Alpha");
    await user.clear(input);
    await user.type(input, "Beta{enter}");

    expect(onRename).toHaveBeenCalledWith("tab-1", "Beta");
  });
});
