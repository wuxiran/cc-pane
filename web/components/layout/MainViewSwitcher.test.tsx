import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MainViewSwitcher from "./MainViewSwitcher";
import type { AppViewMode, ActivityView } from "@/stores/useActivityBarStore";

vi.mock("@/components/Sidebar", () => ({
  default: () => <div data-testid="sidebar" />,
}));
vi.mock("@/components/panes", () => ({
  PaneContainer: () => <div data-testid="pane-container" />,
}));
vi.mock("@/components/panes/StarredPanel", () => ({
  default: () => <div data-testid="starred-panel" />,
}));
vi.mock("@/components/panes/DndPaneProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/editor", () => ({
  FileEditorPanel: () => <div data-testid="file-editor" />,
}));
vi.mock("@/components/todo/TodoManager", () => ({
  default: () => <div data-testid="todo-manager" />,
}));
vi.mock("@/components/selfchat", () => ({
  SelfChatManager: () => <div data-testid="selfchat-manager" />,
}));
vi.mock("@/components/home", () => ({
  HomeDashboard: () => <div data-testid="home-dashboard" />,
}));
vi.mock("@/components/providers", () => ({
  ProvidersPanel: () => <div data-testid="providers-panel" />,
}));
vi.mock("@/components/resources/ResourceHub", () => ({
  default: () => <div data-testid="resource-hub" />,
}));
vi.mock("@/components/orchestration/OrchestrationOverlay", () => ({
  default: () => <div data-testid="orchestration-overlay" />,
}));

const activityState = vi.hoisted(() => ({
  sidebarVisible: true,
  activeView: "explorer" as ActivityView,
  appViewMode: "panes" as AppViewMode,
  orchestrationOverlayOpen: false,
  closeOrchestrationOverlay: () => {},
}));

const panesState = vi.hoisted(() => ({
  rootPane: { type: "panel", id: "root", tabs: [], activeTabId: null },
  layouts: [
    { id: "l1", kind: "normal", rootPane: { type: "panel", id: "root", tabs: [], activeTabId: null } },
  ],
  currentLayoutId: "l1",
}));

vi.mock("@/stores", () => ({
  usePanesStore: (selector: (s: typeof panesState) => unknown) => selector(panesState),
  useActivityBarStore: (selector: (s: typeof activityState) => unknown) => selector(activityState),
}));

function setMode(mode: AppViewMode, overrides: Partial<typeof activityState> = {}) {
  activityState.appViewMode = mode;
  activityState.sidebarVisible = true;
  activityState.activeView = "explorer";
  activityState.orchestrationOverlayOpen = false;
  Object.assign(activityState, overrides);
}

describe("MainViewSwitcher 覆盖全部 appViewMode", () => {
  beforeEach(() => {
    setMode("panes");
  });

  it("home → HomeDashboard 全屏", () => {
    setMode("home");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("home-dashboard")).toBeVisible();
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("keep-alive：切走隐藏不卸载，切回即显示；未访问过的模式不挂载", () => {
    setMode("home");
    const { rerender } = render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("home-dashboard")).toBeVisible();
    // 未访问过 todo：不应挂载
    expect(screen.queryByTestId("todo-manager")).toBeNull();

    // 切到 panes：home 保持挂载但隐藏
    setMode("panes");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("pane-container")).toBeVisible();
    expect(screen.getByTestId("home-dashboard")).not.toBeVisible();

    // 切回 home：同一实例重新显示，panes（含终端）保持挂载
    setMode("home");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("home-dashboard")).toBeVisible();
    expect(screen.getByTestId("pane-container")).not.toBeVisible();
    expect(screen.getAllByTestId("home-dashboard")).toHaveLength(1);
  });

  it("todo → TodoManager 全屏", () => {
    setMode("todo");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("todo-manager")).toBeVisible();
  });

  it("selfchat → SelfChatManager 全屏", () => {
    setMode("selfchat");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("selfchat-manager")).toBeVisible();
  });

  it("providers → ProvidersPanel 全屏", () => {
    setMode("providers");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("providers-panel")).toBeVisible();
  });

  it("resources → ResourceHub 全屏", () => {
    setMode("resources");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("resource-hub")).toBeVisible();
  });

  it("files → Sidebar + FileEditorPanel 组合", () => {
    setMode("files", { activeView: "files" });
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("file-editor")).toBeVisible();
  });

  it("panes → Sidebar + PaneContainer，隐藏侧栏时只剩面板", () => {
    setMode("panes");
    const { unmount } = render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("pane-container")).toBeInTheDocument();
    expect(screen.queryByTestId("orchestration-overlay")).toBeNull();
    unmount();

    setMode("panes", { sidebarVisible: false });
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.getByTestId("pane-container")).toBeInTheDocument();
  });

  it("orchestration → panes 兼容态 + overlay，且不渲染 Sidebar", () => {
    setMode("orchestration", { activeView: "orchestration", sidebarVisible: false });
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("pane-container")).toBeInTheDocument();
    expect(screen.getByTestId("orchestration-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("starred 布局渲染 StarredPanel", () => {
    setMode("panes");
    panesState.layouts = [
      { id: "l1", kind: "starred", rootPane: panesState.rootPane },
    ];
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("starred-panel")).toBeInTheDocument();
    panesState.layouts = [
      { id: "l1", kind: "normal", rootPane: panesState.rootPane },
    ];
  });
});
