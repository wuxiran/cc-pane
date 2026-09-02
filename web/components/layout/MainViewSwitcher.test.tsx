import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  default: ({
    children,
  }: {
    children?: (parts: { sidebar: React.ReactNode; content: React.ReactNode }) => React.ReactNode;
  }) => {
    if (!children) return <div data-testid="todo-manager" />;
    return children({
      sidebar: <div data-testid="todo-sidebar" />,
      content: <div data-testid="todo-manager" />,
    });
  },
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
vi.mock("@/components/orchestration/OrchestrationOverlay", () => ({
  default: () => <div data-testid="orchestration-overlay" />,
}));
vi.mock("@/components/canvas/PaneFlowOverlay", () => ({
  default: () => <div data-testid="pane-flow-overlay" />,
}));
vi.mock("@/components/layoutbar/LayoutTopBar", () => ({
  default: () => <div data-testid="layout-top-bar" />,
}));
vi.mock("@/components/layout/MainWallpaperLayer", () => ({
  default: () => <div data-testid="main-wallpaper-layer" />,
}));
vi.mock("@/components/media/MediaStudio", () => ({
  default: ({
    kind,
    onKindChange,
  }: {
    kind: "image" | "video";
    onKindChange?: (kind: "image" | "video") => void;
  }) => (
    <div data-testid="media-studio-mock" data-media-kind={kind}>
      <button type="button" onClick={() => onKindChange?.(kind === "image" ? "video" : "image")}>
        Switch media kind
      </button>
    </div>
  ),
}));

const activityState = vi.hoisted(() => ({
  sidebarVisible: true,
  activeView: "explorer" as ActivityView,
  appViewMode: "panes" as AppViewMode,
  orchestrationOverlayOpen: false,
  closeOrchestrationOverlay: () => {},
  setAppViewMode: (mode: AppViewMode) => {
    activityState.appViewMode = mode;
  },
}));

const layoutUiState = vi.hoisted(() => ({
  switcherMode: "corner" as "corner" | "topbar",
  setSwitcherMode: () => {},
}));

const panesState = vi.hoisted(() => ({
  rootPane: { type: "panel", id: "root", tabs: [], activeTabId: null },
  layouts: [
    { id: "l1", kind: "normal", rootPane: { type: "panel", id: "root", tabs: [], activeTabId: null } },
  ],
  currentLayoutId: "l1",
}));

const wallpaperState = vi.hoisted(() => ({
  resolved: null as unknown,
  assetUrl: null as string | null,
}));

const canvasDisplayState = vi.hoisted(() => ({
  mode: "panel" as "panel" | "canvas",
}));

const themeState = vi.hoisted(() => ({
  isDark: true,
}));

// 实验功能门禁：默认按「已勾选」跑既有用例，单独的用例把它关掉验证兜底。
const experimentalState = vi.hoisted(() => ({
  mediaGeneration: true,
  skillMarket: true,
}));

vi.mock("@/hooks/useExperimentalFeature", () => ({
  useExperimentalFeature: (id: keyof typeof experimentalState) => experimentalState[id],
  experimentalFeatureEnabled: (id: keyof typeof experimentalState) => experimentalState[id],
}));

vi.mock("@/stores", () => ({
  usePanesStore: (selector: (s: typeof panesState) => unknown) => selector(panesState),
  useActivityBarStore: (selector: (s: typeof activityState) => unknown) => selector(activityState),
  useLayoutUiStore: (selector: (s: typeof layoutUiState) => unknown) => selector(layoutUiState),
  useWallpaperStore: (selector: (s: typeof wallpaperState) => unknown) => selector(wallpaperState),
  useCanvasDisplayStore: (selector: (s: typeof canvasDisplayState) => unknown) => selector(canvasDisplayState),
  useThemeStore: (selector: (s: typeof themeState) => unknown) => selector(themeState),
}));

function setMode(mode: AppViewMode, overrides: Partial<typeof activityState> = {}) {
  activityState.appViewMode = mode;
  activityState.sidebarVisible = true;
  activityState.activeView = "explorer";
  activityState.orchestrationOverlayOpen = false;
  Object.assign(activityState, overrides);
  canvasDisplayState.mode = "panel";
}

describe("MainViewSwitcher 覆盖全部 appViewMode", () => {
  beforeEach(() => {
    setMode("panes");
    wallpaperState.resolved = null;
    wallpaperState.assetUrl = null;
    experimentalState.mediaGeneration = true;
    experimentalState.skillMarket = true;
  });

  it("实验功能未勾选时，imageGen 不挂媒体工作区并退回 panes", async () => {
    experimentalState.mediaGeneration = false;
    setMode("imageGen");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.queryByTestId("media-workspace-shell")).toBeNull();
    await waitFor(() => expect(activityState.appViewMode).toBe("panes"));
  });

  it("实验功能未勾选时，skillMarket 不挂市场页并退回 panes", async () => {
    experimentalState.skillMarket = false;
    setMode("skillMarket");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.queryByTestId("skill-market-shell")).toBeNull();
    await waitFor(() => expect(activityState.appViewMode).toBe("panes"));
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
    const homeLayer = screen.getByTestId("home-dashboard").closest("[data-main-view='home']") as HTMLElement;
    expect(homeLayer).toBeVisible();
    expect(homeLayer).toHaveStyle({ opacity: "1", pointerEvents: "auto" });
    expect(homeLayer).toHaveClass("main-view-layer");
    // 未访问过 todo：不应挂载
    expect(screen.queryByTestId("todo-manager")).toBeNull();

    // 切到 panes：home 保持挂载但隐藏
    setMode("panes");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("pane-container")).toBeVisible();
    expect(screen.getByTestId("home-dashboard")).not.toBeVisible();
    expect(homeLayer).toHaveAttribute("aria-hidden", "true");
    expect(homeLayer).toHaveStyle({ opacity: "0", pointerEvents: "none" });

    // 切回 home：同一实例重新显示，panes（含终端）保持挂载
    setMode("home");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("home-dashboard")).toBeVisible();
    expect(screen.getByTestId("pane-container")).not.toBeVisible();
    expect(screen.getAllByTestId("home-dashboard")).toHaveLength(1);
  });

  it("todo → 共享侧栏中的任务列表 + Todo 主内容", () => {
    setMode("todo");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("todo-sidebar")).toBeVisible();
    expect(screen.getByTestId("todo-manager")).toBeVisible();
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("panes 与 todo 切换时复用同一个展开状态的侧栏过渡容器", () => {
    setMode("panes");
    const { rerender } = render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const regularSidebar = screen.getByTestId("sidebar");
    const transition = regularSidebar.parentElement?.parentElement;

    setMode("todo");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);

    const todoSidebar = screen.getByTestId("todo-sidebar");
    expect(todoSidebar.parentElement?.parentElement).toBe(transition);
    expect(transition).toHaveStyle({ gridTemplateColumns: "1fr" });
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

  it("imageGen 与 videoGen 共用一个媒体工作区并可在其中切换类型", async () => {
    setMode("imageGen");
    const { rerender } = render(<MainViewSwitcher onOpenTerminal={() => {}} />);

    expect(screen.getByTestId("media-workspace-shell")).toBeVisible();
    await waitFor(() => expect(screen.getAllByTestId("media-studio-mock")).toHaveLength(1));
    expect(screen.getByTestId("media-studio-mock")).toHaveAttribute("data-media-kind", "image");

    fireEvent.click(screen.getByRole("button", { name: "Switch media kind" }));
    expect(activityState.appViewMode).toBe("videoGen");

    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getAllByTestId("media-studio-mock")).toHaveLength(1);
    expect(screen.getByTestId("media-studio-mock")).toHaveAttribute("data-media-kind", "video");

    // 离开媒体即卸载（按需挂载语义）；媒体状态在 store 中保留，切回时重建工作区。
    setMode("panes");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.queryByTestId("media-workspace-shell")).toBeNull();
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
    expect(screen.getByTestId("pane-flow-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("orchestration-overlay")).toBeNull();
    unmount();

    setMode("panes", { sidebarVisible: false });
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.getByTestId("pane-container")).toBeInTheDocument();
  });

  it("Canvas 模式隐藏默认 pane 布局并让独立 Canvas 占满主内容区", () => {
    setMode("panes");
    canvasDisplayState.mode = "canvas";
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);

    expect(screen.getByTestId("pane-flow-overlay")).toBeVisible();
    expect(screen.getByTestId("pane-flow-overlay").closest("[data-terminal-canvas-view]")).toHaveStyle({ display: "block" });
    expect(screen.getByTestId("pane-container").closest("[data-terminal-layout-view]")).toHaveStyle({ display: "none" });
  });

  it("orchestration → panes 兼容态 + overlay，且不渲染 Sidebar", () => {
    setMode("orchestration", { activeView: "orchestration", sidebarVisible: false });
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("pane-container")).toBeInTheDocument();
    expect(screen.getByTestId("pane-flow-overlay")).toBeInTheDocument();
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

  it("布局切换器双模式：corner 不渲染布局条，topbar 在 panes 区渲染 LayoutTopBar", () => {
    setMode("panes");
    layoutUiState.switcherMode = "corner";
    const { rerender } = render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.queryByTestId("layout-top-bar")).toBeNull();

    layoutUiState.switcherMode = "topbar";
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("layout-top-bar")).toBeInTheDocument();

    // 非 panes 视图不渲染布局条
    setMode("home");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    expect(screen.getByTestId("layout-top-bar")).not.toBeVisible();
    layoutUiState.switcherMode = "corner";
  });

  it("壁纸激活时面板底覆盖为半透明 color-mix 垫层而非全透明（暗色 62%）", () => {
    setMode("panes");
    wallpaperState.resolved = { kind: "image", glassBlur: 8, dim: 0.35, opacity: 1 };
    wallpaperState.assetUrl = "asset://wallpaper.png";
    themeState.isDark = true;
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);

    const style = screen.getByTestId("main-wallpaper-layer").parentElement?.getAttribute("style") ?? "";
    // 半透明垫层：保留面板底色 62%，只透 38% 给壁纸（全透明会让亮壁纸压过终端文字）
    expect(style).toMatch(/--app-panel-bg-effective:\s*color-mix\(/);
    expect(style).toContain("var(--app-panel-bg) 62%, transparent");
    expect(style).not.toMatch(/--app-panel-bg-effective:\s*transparent\b/);
    // 玻璃模糊 token 仍由壁纸设置接管
    expect(style).toMatch(/--app-glass-blur:\s*8px/);
  });

  it("浅色主题下垫层提浓到 80%，避免壁纸被洗成残影", () => {
    setMode("panes");
    wallpaperState.resolved = { kind: "image", glassBlur: 8, dim: 0.35, opacity: 1 };
    wallpaperState.assetUrl = "asset://wallpaper.png";
    themeState.isDark = false;
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);

    const style = screen.getByTestId("main-wallpaper-layer").parentElement?.getAttribute("style") ?? "";
    expect(style).toContain("var(--app-panel-bg) 80%, transparent");
    expect(style).not.toContain("var(--app-panel-bg) 62%, transparent");
  });

  it("壁纸未激活时不覆盖 effective token", () => {
    setMode("panes");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const style = screen.getByTestId("main-wallpaper-layer").parentElement?.getAttribute("style") ?? "";
    expect(style).not.toContain("--app-panel-bg-effective");
    expect(style).not.toContain("--app-glass-blur");
  });
});
