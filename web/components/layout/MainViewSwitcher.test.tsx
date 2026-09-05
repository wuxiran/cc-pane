import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@/components/skillmarket/SkillMarketPage", () => ({
  default: () => <div data-testid="skill-market-page" />,
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
  dramaStudio: true,
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

  it("keep-alive：切走隐藏不卸载，切回即显示；未访问过的模式不挂载", async () => {
    setMode("home");
    const { rerender } = render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const homeLayer = screen.getByTestId("home-dashboard").closest("[data-main-view='home']") as HTMLElement;
    expect(homeLayer).toBeVisible();
    expect(homeLayer).toHaveStyle({ opacity: "1", pointerEvents: "auto" });
    expect(homeLayer).toHaveClass("main-view-layer");
    // 未访问过 todo：不应挂载
    expect(screen.queryByTestId("todo-manager")).toBeNull();

    // 切到 panes：home 保持挂载但隐藏（panes 播入场视差滑动，等它落到终态）
    setMode("panes");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("pane-container")).toBeVisible());
    expect(screen.getByTestId("home-dashboard")).not.toBeVisible();
    expect(homeLayer).toHaveAttribute("aria-hidden", "true");
    expect(homeLayer).toHaveStyle({ opacity: "0", pointerEvents: "none" });

    // 切回 home：同一实例重新显示，panes（含终端）保持挂载
    setMode("home");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("home-dashboard")).toBeVisible());
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

  it("skillMarket → 市场页挂 main-view-layer，与其余视图共用同一 cross-fade", async () => {
    setMode("skillMarket");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const shell = screen.getByTestId("skill-market-shell");
    expect(shell).toHaveClass("main-view-layer");
    expect(shell).toHaveStyle({ opacity: "1", pointerEvents: "auto" });
    await waitFor(() => expect(screen.getByTestId("skill-market-page")).toBeInTheDocument());
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

describe("亮色壁纸终端区纯色垫层（脏交界修复）", () => {
  const terminalTab = {
    id: "t1",
    title: "zsh",
    contentType: "terminal",
    projectId: "p1",
    projectPath: "/proj",
    sessionId: null,
  };

  function useTerminalLayout() {
    panesState.rootPane = {
      type: "panel",
      id: "root",
      tabs: [terminalTab],
      activeTabId: "t1",
    } as unknown as typeof panesState.rootPane;
  }

  function useEmptyLayout() {
    panesState.rootPane = {
      type: "panel",
      id: "root",
      tabs: [],
      activeTabId: null,
    } as unknown as typeof panesState.rootPane;
  }

  function useWallpaper(terminalOpacity = 1) {
    wallpaperState.resolved = {
      kind: "image",
      glassBlur: 8,
      dim: 0.35,
      opacity: 1,
      terminalOpacity,
    };
    wallpaperState.assetUrl = "asset://wallpaper.png";
  }

  function renderAndGetUnderlay() {
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const panesLayer = screen.getByTestId("main-wallpaper-layer").parentElement as HTMLElement;
    return panesLayer.querySelector("[data-terminal-solid-underlay]") as HTMLElement;
  }

  beforeEach(() => {
    setMode("panes");
    themeState.isDark = false;
    useEmptyLayout();
    useWallpaper(1);
  });

  afterEach(() => {
    useEmptyLayout();
    themeState.isDark = true;
  });

  it("亮色 + 终端主导布局：垫层激活垫纯色 panel 底，effective token 仍保持 80% 半透明", () => {
    useTerminalLayout();
    const underlay = renderAndGetUnderlay();

    expect(underlay).toHaveAttribute("data-active", "true");
    expect(underlay.style.opacity).toBe("1");
    // 禁裸 hex：纯色底只能引用现有 --app-panel-bg token
    expect(underlay.style.background).toBe("var(--app-panel-bg)");
    // 平滑过渡：opacity（垫层淡入）+ background-color（主题切换）都走 --dur
    expect(underlay.style.transition).toContain("opacity var(--dur)");
    expect(underlay.style.transition).toContain("background-color var(--dur)");

    // token 不换：内容区 80% color-mix 落在纯色垫上复合为 100% panel 色
    const panesStyle = (underlay.parentElement as HTMLElement).getAttribute("style") ?? "";
    expect(panesStyle).toContain("var(--app-panel-bg) 80%, transparent");
  });

  it("亮色 + 无终端的空布局：垫层关闭，空态继续透壁纸", () => {
    const underlay = renderAndGetUnderlay();
    expect(underlay).toHaveAttribute("data-active", "false");
    expect(underlay.style.opacity).toBe("0");
  });

  it("暗色 + 终端主导：垫层关闭，暗色 62% 现状不动", () => {
    themeState.isDark = true;
    useTerminalLayout();
    const underlay = renderAndGetUnderlay();
    expect(underlay).toHaveAttribute("data-active", "false");
  });

  it("terminalOpacity<1（默认 0.85 半透明终端）时也垫：xterm 白底与纯色垫混合，壁纸不再透出", () => {
    useTerminalLayout();
    useWallpaper(0.6);
    const underlay = renderAndGetUnderlay();
    expect(underlay).toHaveAttribute("data-active", "true");
  });

  it("canvas 模式不垫：节点之间透壁纸是该视图的设计", () => {
    useTerminalLayout();
    canvasDisplayState.mode = "canvas";
    const underlay = renderAndGetUnderlay();
    expect(underlay).toHaveAttribute("data-active", "false");
  });

  it("壁纸未激活时不垫", () => {
    useTerminalLayout();
    wallpaperState.resolved = null;
    wallpaperState.assetUrl = null;
    const underlay = renderAndGetUnderlay();
    expect(underlay).toHaveAttribute("data-active", "false");
    expect(underlay.style.opacity).toBe("0");
  });
});

describe("签名动效：视图切入视差滑动", () => {
  function mainViewLayer(testId: string, view: string) {
    return screen.getByTestId(testId).closest(`[data-main-view='${view}']`) as HTMLElement;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("首次挂载不播动效（无位移、无内联过渡）", () => {
    setMode("panes");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const panesLayer = mainViewLayer("pane-container", "panes");
    expect(panesLayer.hasAttribute("data-enter-motion")).toBe(false);
    expect(panesLayer.style.transform).toBe("");
    expect(panesLayer.style.transition).toBe("");
  });

  it("进入层 opacity + translateY(6px)→0（--dur-slow --ease-out），离场层纯 fade 无位移", async () => {
    setMode("panes");
    const { rerender } = render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const panesLayer = mainViewLayer("pane-container", "panes");

    setMode("home");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const homeLayer = mainViewLayer("home-dashboard", "home");

    // 起始帧：落位 6px、opacity 0、无过渡（双 rAF 的第一拍）
    expect(homeLayer).toHaveAttribute("data-enter-motion", "from");
    expect(homeLayer.style.transform).toBe("translateY(6px)");
    expect(homeLayer.style.opacity).toBe("0");
    expect(homeLayer.style.transition).toBe("none");
    // 离场层：不带位移、不带内联过渡，纯 CSS 类 fade（opacity var(--dur)）
    expect(panesLayer.hasAttribute("data-enter-motion")).toBe(false);
    expect(panesLayer.style.transform).toBe("");
    expect(panesLayer.style.transition).toBe("");

    // 下一帧：滑向终态，过渡走 --dur-slow + --ease-out，且只入不追（transform 终态归零）
    await waitFor(() => expect(homeLayer).toHaveAttribute("data-enter-motion", "to"));
    expect(homeLayer.style.transform).toBe("translateY(0)");
    expect(homeLayer.style.opacity).toBe("1");
    expect(homeLayer.style.transition).toContain("opacity var(--dur-slow) var(--ease-out)");
    expect(homeLayer.style.transition).toContain("transform var(--dur-slow) var(--ease-out)");

    // 收尾：摘掉内联动效，后续离场交还 .main-view-layer 的纯 fade
    await waitFor(() => expect(homeLayer.hasAttribute("data-enter-motion")).toBe(false), {
      timeout: 2000,
    });
    expect(homeLayer.style.transform).toBe("");
    expect(homeLayer.style.transition).toBe("");
    expect(homeLayer.style.opacity).toBe("1");
  });

  it("prefers-reduced-motion：退回纯 fade，无视差位移、无内联过渡", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    );
    setMode("panes");
    const { rerender } = render(<MainViewSwitcher onOpenTerminal={() => {}} />);

    setMode("home");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const homeLayer = mainViewLayer("home-dashboard", "home");

    // 直接呈现活动终态（opacity 由 CSS 类 fade 收短到 60ms），全程无位移
    expect(homeLayer.hasAttribute("data-enter-motion")).toBe(false);
    expect(homeLayer.style.transform).toBe("");
    expect(homeLayer.style.transition).toBe("");
    expect(homeLayer.style.opacity).toBe("1");
  });
});

describe("inert：隐藏 keep-alive 层不持焦（aria-hidden 焦点告警修复）", () => {
  function mainViewLayer(testId: string, view: string) {
    return screen.getByTestId(testId).closest(`[data-main-view='${view}']`) as HTMLElement;
  }

  it("首次挂载的活动层不带 inert，aria-hidden 为 false", () => {
    setMode("panes");
    render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const panesLayer = mainViewLayer("pane-container", "panes");
    expect(panesLayer.hasAttribute("inert")).toBe(false);
    expect(panesLayer).toHaveAttribute("aria-hidden", "false");
  });

  it("非活动 keep-alive 层带 inert + aria-hidden，活动层不带；切换后互换", async () => {
    setMode("home");
    const { rerender } = render(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const homeLayer = mainViewLayer("home-dashboard", "home");
    expect(homeLayer.hasAttribute("inert")).toBe(false);
    expect(homeLayer).toHaveAttribute("aria-hidden", "false");

    // 切到 panes：home 保持挂载但隐藏，inert 使子树不可聚焦/不可命中
    setMode("panes");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("pane-container")).toBeVisible());
    const panesLayer = mainViewLayer("pane-container", "panes");
    expect(homeLayer.hasAttribute("inert")).toBe(true);
    expect(homeLayer).toHaveAttribute("aria-hidden", "true");
    expect(panesLayer.hasAttribute("inert")).toBe(false);
    expect(panesLayer).toHaveAttribute("aria-hidden", "false");

    // 切回 home：inert 摘除，焦点/命中能力恢复；panes 层转入 inert
    setMode("home");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("home-dashboard")).toBeVisible());
    expect(homeLayer.hasAttribute("inert")).toBe(false);
    expect(homeLayer).toHaveAttribute("aria-hidden", "false");
    expect(panesLayer.hasAttribute("inert")).toBe(true);
    expect(panesLayer).toHaveAttribute("aria-hidden", "true");
  });

  it("enterMotion 视差动画期间，进入层（活动层）全程不带 inert", async () => {
    setMode("panes");
    const { rerender } = render(<MainViewSwitcher onOpenTerminal={() => {}} />);

    setMode("home");
    rerender(<MainViewSwitcher onOpenTerminal={() => {}} />);
    const homeLayer = mainViewLayer("home-dashboard", "home");

    // 起始帧（from）：进入层已可交互，无 inert
    expect(homeLayer).toHaveAttribute("data-enter-motion", "from");
    expect(homeLayer.hasAttribute("inert")).toBe(false);
    // 过渡帧（to）：仍无 inert
    await waitFor(() => expect(homeLayer).toHaveAttribute("data-enter-motion", "to"));
    expect(homeLayer.hasAttribute("inert")).toBe(false);
    // 收尾后依然无 inert
    await waitFor(() => expect(homeLayer.hasAttribute("data-enter-motion")).toBe(false), {
      timeout: 2000,
    });
    expect(homeLayer.hasAttribute("inert")).toBe(false);
  });
});
