import "@/i18n";
import type { ReactElement } from "react";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import LayoutTopBar from "./LayoutTopBar";
import { useActivityBarStore, usePanesStore } from "@/stores";
import { createPanel } from "@/stores/paneTreeHelpers";
import type { Panel, PaneNode, SplitPane } from "@/types";

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
