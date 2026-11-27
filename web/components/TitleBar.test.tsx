import "@/i18n";
import type { ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import TitleBar from "./TitleBar";
import { useAiPanelStore } from "@/stores/useAiPanelStore";

function renderTitleBar(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const mockUseBorderlessStore = vi.fn();
const mockStartDrag = vi.fn();
const mockCloseWindow = vi.fn();
const mockMinimizeWindow = vi.fn();
const mockMaximizeWindow = vi.fn();
const mockToggleFullscreenWindow = vi.fn();
const mockTogglePin = vi.fn();
const mockIsPinned = vi.fn<() => boolean>();
const mockToggleSidebar = vi.fn();
const mockSidebarVisible = vi.fn<() => boolean>();
const mockToggleRightDock = vi.fn();
const mockRightDockVisible = vi.fn<() => boolean>();

vi.mock("@/stores", () => ({
  useActivityBarStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      sidebarVisible: mockSidebarVisible(),
      toggleSidebar: mockToggleSidebar,
    }),
  useBorderlessStore: (selector: (state: { isBorderless: boolean }) => boolean) =>
    selector({ isBorderless: mockUseBorderlessStore() }),
  useWorkspacesStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      workspaces: [],
      expandedWorkspaceId: null,
      expandedProjectId: null,
      expandWorkspace: () => {},
      expandProject: () => {},
    }),
  useDialogStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openSettings: () => {} }),
  useRightDockStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      visible: mockRightDockVisible(),
      toggleVisible: mockToggleRightDock,
    }),
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: { shortcuts: { bindings: { "toggle-right-dock": "Ctrl+Alt+B" } } } }),
  formatKeyCombo: (combo: string) => combo,
}));

vi.mock("@/hooks/useWindowControl", () => ({
  useWindowControl: () => ({
    closeWindow: mockCloseWindow,
    minimizeWindow: mockMinimizeWindow,
    maximizeWindow: mockMaximizeWindow,
    toggleFullscreenWindow: mockToggleFullscreenWindow,
    isMaximized: false,
    isPinned: mockIsPinned(),
    togglePin: mockTogglePin,
    startDrag: mockStartDrag,
  }),
}));

describe("TitleBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseBorderlessStore.mockReturnValue(false);
    mockSidebarVisible.mockReturnValue(true);
    mockRightDockVisible.mockReturnValue(false);
    mockIsPinned.mockReturnValue(false);
    useAiPanelStore.setState({ panels: [], activePanelId: null, unreadPanelIds: [] });
  });

  it("marks the whole titlebar as a native drag region", () => {
    const { container } = renderTitleBar(<TitleBar workspaceName="Workspace A" />);
    const titlebar = container.firstElementChild as HTMLDivElement;

    expect(titlebar).toHaveAttribute("data-tauri-drag-region", "");
    expect(screen.getByText("Workspace A")).toBeInTheDocument();
  });

  it("keeps window controls out of the drag region", () => {
    renderTitleBar(<TitleBar />);

    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    const minimizeButton = screen.getByRole("button", { name: "最小化" });

    fireEvent.click(minimizeButton);
    expect(mockMinimizeWindow).toHaveBeenCalledTimes(1);
    expect(mockStartDrag).not.toHaveBeenCalled();
  });

  it("starts dragging from the center spacer", () => {
    renderTitleBar(<TitleBar />);

    fireEvent.mouseDown(screen.getByTestId("titlebar-drag-spacer"), { button: 0 });

    expect(mockStartDrag).toHaveBeenCalledTimes(1);
  });

  it("toggles fullscreen on center spacer double click", () => {
    renderTitleBar(<TitleBar />);

    fireEvent.mouseDown(screen.getByTestId("titlebar-drag-spacer"), { button: 0, detail: 2 });

    expect(mockToggleFullscreenWindow).toHaveBeenCalledTimes(1);
    expect(mockStartDrag).not.toHaveBeenCalled();
  });

  it("toggles fullscreen on workspace title double click", () => {
    renderTitleBar(<TitleBar workspaceName="Workspace A" />);

    fireEvent.doubleClick(screen.getByText("Workspace A"));

    expect(mockToggleFullscreenWindow).toHaveBeenCalledTimes(1);
    expect(mockStartDrag).not.toHaveBeenCalled();
  });

  // 按钮的 -webkit-app-region: no-drag 无法在此断言：jsdom 不识别该属性，
  // React 写入时会被整条丢弃（style 属性为 null）。同窗口控制按钮一样，
  // 只能退而验证「点击到达按钮且没有被当成拖拽」。
  it.each<[string, typeof mockToggleSidebar]>([
    ["titlebar-toggle-sidebar", mockToggleSidebar],
    ["titlebar-toggle-right-dock", mockToggleRightDock],
  ])("%s toggles its panel without starting a drag", (testId, toggle) => {
    renderTitleBar(<TitleBar />);

    fireEvent.click(screen.getByTestId(testId));

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(mockStartDrag).not.toHaveBeenCalled();
  });

  it.each<[string, typeof mockSidebarVisible, string, string]>([
    ["titlebar-toggle-sidebar", mockSidebarVisible, "折叠侧边栏", "展开侧边栏"],
    ["titlebar-toggle-right-dock", mockRightDockVisible, "折叠右侧面板", "展开右侧面板"],
  ])("%s label follows panel visibility", (testId, visible, whenShown, whenHidden) => {
    for (const [shown, label] of [[true, whenShown], [false, whenHidden]] as const) {
      visible.mockReturnValue(shown);
      const { unmount } = renderTitleBar(<TitleBar />);
      expect(screen.getByTestId(testId)).toHaveAttribute("aria-label", label);
      unmount();
    }
  });

  it("右上角提供窗口置顶开关，点击切换且不触发拖拽", () => {
    renderTitleBar(<TitleBar />);

    const pin = screen.getByTestId("titlebar-toggle-always-on-top");
    expect(pin).toHaveAttribute("aria-label", "窗口置顶");
    expect(pin).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(pin);

    expect(mockTogglePin).toHaveBeenCalledTimes(1);
    expect(mockStartDrag).not.toHaveBeenCalled();
  });

  it("置顶时图钉按钮高亮并标记 pressed", () => {
    mockIsPinned.mockReturnValue(true);
    renderTitleBar(<TitleBar />);

    const pin = screen.getByTestId("titlebar-toggle-always-on-top");
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(pin.className).toContain("text-[var(--app-accent)]");
    expect(pin.querySelector(".rotate-45")).not.toBeNull();
  });

  it("does not extend the right dock divider through the titlebar", () => {
    mockRightDockVisible.mockReturnValue(true);
    const { container } = renderTitleBar(<TitleBar />);

    expect(container.querySelector("[data-right-dock-divider]")).toBeNull();
  });

  it("shows an amber dot on the right dock entry for unread AI panels", () => {
    useAiPanelStore.setState({ unreadPanelIds: ["panel-1"] });

    renderTitleBar(<TitleBar />);

    expect(screen.getByTestId("titlebar-ai-panel-badge")).toBeInTheDocument();
  });

  it("hides itself in borderless mode", () => {
    mockUseBorderlessStore.mockReturnValue(true);

    const { container } = renderTitleBar(<TitleBar />);

    expect(container).toBeEmptyDOMElement();
  });
});
