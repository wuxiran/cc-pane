import "@/i18n";
import type { ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import TitleBar from "./TitleBar";

function renderTitleBar(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const mockUseBorderlessStore = vi.fn();
const mockStartDrag = vi.fn();
const mockCloseWindow = vi.fn();
const mockMinimizeWindow = vi.fn();
const mockMaximizeWindow = vi.fn();
const mockToggleFullscreenWindow = vi.fn();
const mockToggleSidebar = vi.fn();
const mockSidebarVisible = vi.fn<() => boolean>();

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
}));

vi.mock("@/hooks/useWindowControl", () => ({
  useWindowControl: () => ({
    closeWindow: mockCloseWindow,
    minimizeWindow: mockMinimizeWindow,
    maximizeWindow: mockMaximizeWindow,
    toggleFullscreenWindow: mockToggleFullscreenWindow,
    isMaximized: false,
    startDrag: mockStartDrag,
  }),
}));

describe("TitleBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseBorderlessStore.mockReturnValue(false);
    mockSidebarVisible.mockReturnValue(true);
  });

  it("marks the whole titlebar as a native drag region", () => {
    const { container } = renderTitleBar(<TitleBar workspaceName="Workspace A" />);
    const titlebar = container.firstElementChild as HTMLDivElement;

    expect(titlebar).toHaveAttribute("data-tauri-drag-region", "");
    expect(screen.getByText("Workspace A")).toBeInTheDocument();
  });

  it("keeps window controls out of the drag region", () => {
    renderTitleBar(<TitleBar />);

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
  it("toggles the sidebar from the titlebar switch without starting a drag", () => {
    renderTitleBar(<TitleBar />);

    fireEvent.click(screen.getByTestId("titlebar-toggle-sidebar"));

    expect(mockToggleSidebar).toHaveBeenCalledTimes(1);
    expect(mockStartDrag).not.toHaveBeenCalled();
  });

  it("swaps the sidebar switch icon and label with sidebarVisible", () => {
    const { unmount } = renderTitleBar(<TitleBar />);

    expect(screen.getByTestId("titlebar-toggle-sidebar")).toHaveAttribute(
      "aria-label",
      "折叠侧边栏",
    );
    expect(
      screen.getByTestId("titlebar-toggle-sidebar").querySelector(".lucide-panel-left-close"),
    ).not.toBeNull();
    unmount();

    mockSidebarVisible.mockReturnValue(false);
    renderTitleBar(<TitleBar />);

    expect(screen.getByTestId("titlebar-toggle-sidebar")).toHaveAttribute(
      "aria-label",
      "展开侧边栏",
    );
    expect(
      screen.getByTestId("titlebar-toggle-sidebar").querySelector(".lucide-panel-left"),
    ).not.toBeNull();
  });

  it("hides itself in borderless mode", () => {
    mockUseBorderlessStore.mockReturnValue(true);

    const { container } = renderTitleBar(<TitleBar />);

    expect(container).toBeEmptyDOMElement();
  });
});
