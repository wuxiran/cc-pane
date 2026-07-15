import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import type { LayoutEntry, Panel, Tab, TerminalStatusInfo } from "@/types";
import StarredPanel from "./StarredPanel";

// 镜像格子挂真实 TerminalView（xterm）——jsdom 下 mock 成 sessionId 标记节点
vi.mock("./TerminalView", () => ({
  default: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="mirror-terminal" data-session-id={sessionId} />
  ),
}));

function makeTerminalTab(overrides?: Partial<Tab>): Tab {
  return {
    id: "tab-1",
    title: "Project One",
    contentType: "terminal",
    projectId: "project-1",
    projectPath: "/tmp/project-one",
    sessionId: "session-1",
    terminalRootPane: {
      type: "leaf",
      id: "leaf-1",
      sessionId: "session-1",
    },
    activeTerminalPaneId: "leaf-1",
    ...overrides,
  };
}

function makePanel(tab: Tab, id = "pane-1"): Panel {
  return {
    type: "panel",
    id,
    tabs: [tab],
    activeTabId: tab.id,
  };
}

function makeLayout(id: string, name: string, rootPane: Panel, kind: LayoutEntry["kind"] = "normal"): LayoutEntry {
  return {
    id,
    name,
    kind,
    rootPane,
    activePaneId: rootPane.id,
  };
}

describe("StarredPanel", () => {
  beforeEach(() => {
    const rootPane = makePanel(makeTerminalTab({ starred: true }));
    const starredRootPane = makePanel(makeTerminalTab({ id: "starred-placeholder", title: "Starred Placeholder" }), "pane-starred");
    usePanesStore.setState({
      rootPane,
      activePaneId: rootPane.id,
      layouts: [
        makeLayout("layout-1", "布局 1", rootPane),
        makeLayout("layout-starred", "星标", starredRootPane, "starred"),
      ],
      currentLayoutId: "layout-1",
      closedTabs: [],
      poppedOutTabs: new Set<string>(),
    });

    const status: TerminalStatusInfo = {
      sessionId: "session-1",
      status: "active",
      lastOutputAt: 1,
      updatedAt: 1,
    };
    useTerminalStatusStore.setState({ statusMap: new Map([[status.sessionId, status]]) });
  });

  it("renders starred tabs without resubscribing to a fresh store snapshot", () => {
    render(<StarredPanel />);

    expect(screen.getByText("Project One")).toBeInTheDocument();
    expect(screen.getByText("布局 1")).toBeInTheDocument();
  });

  it("mounts a live terminal mirror bound to the original tab's session", () => {
    render(<StarredPanel />);

    const mirror = screen.getByTestId("mirror-terminal");
    expect(mirror).toHaveAttribute("data-session-id", "session-1");
  });

  it("shows a placeholder instead of a mirror when the session has not started", () => {
    const rootPane = makePanel(
      makeTerminalTab({
        starred: true,
        sessionId: null,
        terminalRootPane: { type: "leaf", id: "leaf-1", sessionId: null },
      }),
    );
    usePanesStore.setState({
      rootPane,
      layouts: [makeLayout("layout-1", "布局 1", rootPane)],
      currentLayoutId: "layout-1",
    });

    render(<StarredPanel />);

    expect(screen.queryByTestId("mirror-terminal")).not.toBeInTheDocument();
  });

  it("jump button navigates back to the original tab", () => {
    const openStarredTab = vi.fn();
    usePanesStore.setState({ openStarredTab } as never);

    render(<StarredPanel />);
    fireEvent.click(screen.getByRole("button", { name: /打开|Open/ }));

    expect(openStarredTab).toHaveBeenCalledWith("tab-1");
  });

  it("removes the mirror when the tab is unstarred", () => {
    const { rerender } = render(<StarredPanel />);
    expect(screen.getByTestId("mirror-terminal")).toBeInTheDocument();

    const rootPane = makePanel(makeTerminalTab({ starred: false }));
    usePanesStore.setState({
      rootPane,
      layouts: [makeLayout("layout-1", "布局 1", rootPane)],
      currentLayoutId: "layout-1",
    });
    rerender(<StarredPanel />);

    expect(screen.queryByTestId("mirror-terminal")).not.toBeInTheDocument();
  });
});
