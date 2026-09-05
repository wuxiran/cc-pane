// 主内容区视图切换：收拢 useActivityBarStore 的全部 appViewMode 分支。
// keep-alive 语义：每个视图首次访问时挂载，之后固定在同一舞台上，仅切换 opacity。
// 视图树（尤其终端 xterm）不会重建；重新显示时 TerminalView 的 ResizeObserver 负责 refit。
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Sidebar from "@/components/Sidebar";
import SidebarTransition from "@/components/layout/SidebarTransition";
import SidebarFlyout from "@/components/layout/SidebarFlyout";
import { PaneContainer } from "@/components/panes";
import StarredPanel from "@/components/panes/StarredPanel";
import DndPaneProvider from "@/components/panes/DndPaneProvider";
import { FileEditorPanel } from "@/components/editor";
import TodoManager from "@/components/todo/TodoManager";
import { SelfChatManager } from "@/components/selfchat";
import { HomeDashboard } from "@/components/home";
import { ProvidersPanel } from "@/components/providers";
import OrchestrationOverlay from "@/components/orchestration/OrchestrationOverlay";
import PaneFlowOverlay from "@/components/canvas/PaneFlowOverlay";
import { LayoutVisibilityContext } from "@/contexts/LayoutVisibilityContext";
import LayoutTopBar from "@/components/layoutbar/LayoutTopBar";
import MainWallpaperLayer from "@/components/layout/MainWallpaperLayer";
import { useCanvasDisplayStore, usePanesStore, useActivityBarStore, useLayoutUiStore, useWallpaperStore, useThemeStore, type AppViewMode } from "@/stores";
import type { OpenTerminalOptions } from "@/types";
import type { MediaStudioKind } from "@/stores/useMediaStudioStore";
import { useExperimentalFeature } from "@/hooks/useExperimentalFeature";
import { useResponsiveSidebar } from "@/hooks/useResponsiveSidebar";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { collectPanels } from "@/lib/paneTree";

// Keep the media workspace out of the initial terminal module graph. Besides
// reducing startup work, this lets the existing terminal-only test doubles and
// lightweight web deployments omit media-specific dependencies until opened.
const MediaStudio = lazy(() => import("@/components/media/MediaStudio"));
const DramaStudio = lazy(() => import("@/components/drama/DramaStudio"));
const SkillMarketPage = lazy(() => import("@/components/skillmarket/SkillMarketPage"));

interface MainViewSwitcherProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

// 壁纸激活时的面板底：不透明面板色保留 62%，只留 38% 透出壁纸。全透明会让亮色
// 壁纸直接垫在终端文字下（对比度崩塌）；62% 既能恢复一层「面板深度」垫住文字，
// 又不至于把壁纸遮得几乎看不见。同思路先例：空态磨砂垫底（emptyStateShared）。
const WALLPAPER_PANEL_BG_EFFECTIVE_DARK =
  "color-mix(in srgb, var(--app-panel-bg) 62%, transparent)";
// 浅色主题面板底是近白，同一浓度会把高对比壁纸洗成一层米色残影（实机走查结论），
// 提浓到 80% 让壁纸退成隐约纹理、维持浅色应有的干净表面。
const WALLPAPER_PANEL_BG_EFFECTIVE_LIGHT =
  "color-mix(in srgb, var(--app-panel-bg) 80%, transparent)";

// 签名动效（视差滑动）参数：进入层位移起点。幅度刻意小——这是全应用唯一的
// 签名动效，只入不追；时长/缓动全部走 --dur-slow / --ease-out token（见 viewStyle）。
const ENTER_OFFSET_Y = "translateY(6px)";
// 收尾计时：--dur-slow(240ms) 结束后摘掉内联过渡，把离场 fade 时长交还 CSS 类
// （var(--dur)）。JS 侧没有 token 可读，取 240ms + 一帧余量。
const ENTER_SETTLE_MS = 300;

export default function MainViewSwitcher({ onOpenTerminal }: MainViewSwitcherProps) {
  const { t: mediaT } = useTranslation("media");
  const { t: commonT } = useTranslation("common");
  const rootPane = usePanesStore((s) => s.rootPane);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);

  const layoutSwitcherMode = useLayoutUiStore((s) => s.switcherMode);
  const canvasDisplayMode = useCanvasDisplayStore((s) => s.mode);
  const sidebarVisible = useActivityBarStore((s) => s.sidebarVisible);
  const setSidebarVisible = useActivityBarStore((s) => s.setSidebarVisible);
  const isDark = useThemeStore((s) => s.isDark);
  const activeView = useActivityBarStore((s) => s.activeView);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
  const orchestrationOverlayOpen = useActivityBarStore((s) => s.orchestrationOverlayOpen);
  const closeOrchestrationOverlay = useActivityBarStore((s) => s.closeOrchestrationOverlay);
  // 原子字段 selector（布尔），不在 selector 里做对象解析
  const wallpaperActive = useWallpaperStore((s) => s.resolved !== null && s.assetUrl !== null);
  const wallpaperGlassBlur = useWallpaperStore((s) => s.resolved?.glassBlur ?? 0);

  const showOrchestrationOverlay =
    orchestrationOverlayOpen ||
    appViewMode === "orchestration" ||
    (activeView === "orchestration" && sidebarVisible);
  // orchestration 是"panes + overlay"的兼容态，不是独立全屏视图
  const effectiveAppViewMode = appViewMode === "orchestration" ? "panes" : appViewMode;
  const mediaGenerationEnabled = useExperimentalFeature("mediaGeneration");
  const dramaStudioEnabled = useExperimentalFeature("dramaStudio");
  const skillMarketEnabled = useExperimentalFeature("skillMarket");
  const mediaRequested = effectiveAppViewMode === "imageGen" || effectiveAppViewMode === "videoGen";
  const mediaActive = mediaRequested && mediaGenerationEnabled;
  const mediaKind: MediaStudioKind = effectiveAppViewMode === "videoGen" ? "video" : "image";
  // 实验功能被关掉时（设置里取消勾选、或旧链路仍把模式设成了它）退回 panes，
  // 不能停在一个既不渲染又没有出口的空视图上。
  const dramaActive = effectiveAppViewMode === "dramaGen" && dramaStudioEnabled;
  const gatedModeBlocked =
    (mediaRequested && !mediaGenerationEnabled)
    || (effectiveAppViewMode === "dramaGen" && !dramaStudioEnabled)
    || (effectiveAppViewMode === "skillMarket" && !skillMarketEnabled);
  useEffect(() => {
    if (gatedModeBlocked) setAppViewMode("panes");
  }, [gatedModeBlocked, setAppViewMode]);
  // Todo 与 panes/files 共用同一个侧栏过渡容器，切换模块时宽度保持稳定。
  const shouldShowSidebar =
    sidebarVisible &&
    activeView !== "orchestration" &&
    (effectiveAppViewMode === "panes"
      || effectiveAppViewMode === "files"
      || effectiveAppViewMode === "todo");
  // 窄档（<1024px）：侧栏改浮出层，常驻过渡容器让位（0fr 收起并卸载）。
  const { isFlyout } = useResponsiveSidebar();

  // keep-alive：记录访问过的模式；未访问过的不挂载（保持启动开销不变）
  const [visited, setVisited] = useState<ReadonlySet<AppViewMode>>(
    () => new Set([effectiveAppViewMode]),
  );
  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(effectiveAppViewMode)) return prev;
      const next = new Set(prev);
      next.add(effectiveAppViewMode);
      return next;
    });
  }, [effectiveAppViewMode]);

  const isActive = (mode: AppViewMode) => effectiveAppViewMode === mode;
  // 首次切入时 visited 尚未含当前模式（effect 晚一拍），用 isActive 兜底立即挂载
  const isMounted = (mode: AppViewMode) => visited.has(mode) || isActive(mode);

  // ===== aria-hidden 焦点告警修复：隐藏 keep-alive 层加 inert =====
  // 现状：隐藏层只有 aria-hidden + opacity 0 + pointer-events none，层内已聚焦的
  // 元素（如实机 home 层里的 button）不丢焦，Chromium 持续告警
  // "Blocked aria-hidden on an element because its descendant retained focus"。
  // 方案选 inert 而非「切视图手动移焦」：inert 是声明式状态，随活动态自动加/摘，
  // 子树即刻不可聚焦/不可命中/对 AT 隐藏，且 Chromium 会把层内滞留焦点释放到
  // body——告警根源（aria-hidden 子树持焦）被结构性消除。手动移焦要在每次切换
  // 时抢焦点、还要记住切回时恢复到哪个元素，状态机和 enterMotion 动画期交互
  // 都会变复杂，收益为零。aria-hidden 保留作双保险（inert 本身已对 AT 隐藏，
  // 冗余声明无害且兼容不理解 inert 的旧 AT）。WebView2 为 Chromium 原生支持，
  // 无需 polyfill。进入层恒为活动层（enterMotion.mode === effectiveAppViewMode），
  // 永不带 inert，动画期间交互不受限。
  const layerA11yAttrs = (mode: AppViewMode) => {
    const active = isActive(mode);
    return { "aria-hidden": !active, inert: !active };
  };

  // ===== 亮色壁纸「脏交界」修复 =====
  // 亮色主题下 --app-panel-bg-effective 是 80% 半透明（提浓注释见上方常量），
  // 壁纸会透出面板；terminalOpacity<1（默认 0.85）时 xterm 本体也透壁纸，与白字
  // 终端交界显脏。修复在 panes 根节点内、壁纸层之上垫一层纯色 panel 底（不动
  // panes/ 内部）：内容区读的 80% color-mix 落在纯色垫上即复合为 100% panel 色，
  // xterm 的半透明白底也与纯色垫混合——壁纸不再透出，但 0.85 的柔和观感保留。
  // 只在「终端主导」时垫——无终端的空态/启动器仍透壁纸。
  // 暗色维持 62% 现状（暗色下不脏）；canvas 模式不垫（节点间透壁纸是该视图的设计）。
  const currentLayoutHasTerminal = useMemo(
    () =>
      collectPanels(rootPane).some((panel) =>
        panel.tabs.some((tab) => tab.contentType === "terminal"),
      ),
    [rootPane],
  );
  const terminalSolidUnderlay =
    wallpaperActive &&
    !isDark &&
    canvasDisplayMode === "panel" &&
    currentLayoutHasTerminal;

  // ===== 签名动效：视图切入视差滑动（全应用唯一）=====
  // 进入层 opacity 0→1 + translateY(6px)→0（--dur-slow + --ease-out）；
  // 离场层不加位移，仍是 .main-view-layer 的 opacity var(--dur) 纯 fade。
  // index.css 的 .main-view-layer 规则被 layoutMotion.test.ts 锁定（不许含
  // transform），所以位移只能走组件内联样式 + 双 rAF。reduced-motion 退回纯 fade。
  const reduceMotion = usePrefersReducedMotion();
  const [enterMotion, setEnterMotion] = useState<{ mode: AppViewMode; stage: "from" | "to" } | null>(null);
  const prevViewModeRef = useRef(effectiveAppViewMode);
  useEffect(() => {
    if (prevViewModeRef.current === effectiveAppViewMode) return;
    prevViewModeRef.current = effectiveAppViewMode;
    if (reduceMotion) return;
    setEnterMotion({ mode: effectiveAppViewMode, stage: "from" });
    // 双 rAF：先提交起始帧（transition: none 落位 6px），下一帧再挂过渡滑向终态。
    let rafTo = 0;
    const rafFrom = requestAnimationFrame(() => {
      rafTo = requestAnimationFrame(() => {
        setEnterMotion((prev) => (prev ? { ...prev, stage: "to" } : prev));
      });
    });
    const settle = window.setTimeout(() => setEnterMotion(null), ENTER_SETTLE_MS);
    return () => {
      cancelAnimationFrame(rafFrom);
      cancelAnimationFrame(rafTo);
      window.clearTimeout(settle);
    };
  }, [effectiveAppViewMode, reduceMotion]);

  // All visited views share one fixed stage. Inactive views stay mounted and
  // are absolutely positioned, so switching modules only animates opacity and
  // never changes the flex dimensions observed by xterm.
  const viewStyle = (mode: AppViewMode): React.CSSProperties => {
    const active = isActive(mode);
    const entering = enterMotion?.mode === mode ? enterMotion : null;
    if (entering) {
      // 签名动效进行中：内联 transition 接管（opacity + transform，--dur-slow）。
      return {
        opacity: entering.stage === "from" ? 0 : 1,
        transform: entering.stage === "from" ? ENTER_OFFSET_Y : "translateY(0)",
        transition:
          entering.stage === "from"
            ? "none"
            : "opacity var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-out)",
        pointerEvents: "auto",
        zIndex: 1,
      };
    }
    return {
      opacity: active ? 1 : 0,
      pointerEvents: active ? "auto" : "none",
      zIndex: active ? 1 : 0,
    };
  };
  // 视差滑动阶段标记（from/to），供测试与排查定位进入层；非进入层不带该属性。
  const viewMotionAttr = (mode: AppViewMode) => ({
    "data-enter-motion": enterMotion?.mode === mode ? enterMotion.stage : undefined,
  });

  return (
    <TodoManager scope="" scopeRef="" enabled={isMounted("todo")}>
      {({ sidebar: todoSidebar, content: todoContent }) => (
        <>
      {/* panes/files/todo 共用同一侧栏实例，模块切换不会触发不同的进出场动画。
          窄档下 inline 侧栏让位给 main 内的浮出层（见下方 SidebarFlyout）。 */}
      <SidebarTransition visible={shouldShowSidebar && !isFlyout}>
        {isActive("todo") ? todoSidebar : (
          <Sidebar
            activeView={activeView}
            onOpenTerminal={onOpenTerminal}
          />
        )}
      </SidebarTransition>

      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden" data-main-view-stage>
      {/* 首页仪表盘 */}
      {isMounted("home") && (
        <div
          className="main-view-layer absolute inset-0 overflow-hidden"
          data-main-view="home"
          {...layerA11yAttrs("home")}
          {...viewMotionAttr("home")}
          style={viewStyle("home")}
        >
          <HomeDashboard onOpenTerminal={onOpenTerminal} />
        </div>
      )}
      {/* Todo 主内容；任务列表由上方共享侧栏承载。 */}
      {isMounted("todo") && (
        <div
          className="main-view-layer absolute inset-0 overflow-hidden"
          data-main-view="todo"
          {...layerA11yAttrs("todo")}
          {...viewMotionAttr("todo")}
          style={{ background: "var(--app-panel-bg)", ...viewStyle("todo") }}
        >
          {todoContent}
        </div>
      )}
      {/* Self-Chat 全屏模式 */}
      {isMounted("selfchat") && (
        <div
          className="main-view-layer absolute inset-0 overflow-hidden"
          data-main-view="selfchat"
          {...layerA11yAttrs("selfchat")}
          {...viewMotionAttr("selfchat")}
          style={viewStyle("selfchat")}
        >
          <SelfChatManager />
        </div>
      )}
      {/* Providers 全屏模式（旧入口，保留兼容） */}
      {isMounted("providers") && (
        <div
          className="main-view-layer absolute inset-0 overflow-hidden"
          data-main-view="providers"
          {...layerA11yAttrs("providers")}
          {...viewMotionAttr("providers")}
          style={viewStyle("providers")}
        >
          <ProvidersPanel />
        </div>
      )}
      {/* 生图与生视频共用一个媒体工作区；类型切换只替换工作区内部的表单。
          按需挂载：仅激活时渲染，实验功能关掉时自然不存在于 DOM。 */}
      {mediaActive && (
        <div
          className="main-view-layer absolute inset-0 flex min-w-0 overflow-hidden"
          data-main-view="media"
          data-testid="media-workspace-shell"
        >
          <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>{mediaT("loadingMediaWorkspace")}</div>}>
            <MediaStudio
              kind={mediaKind}
              onKindChange={(nextKind) => setAppViewMode(nextKind === "image" ? "imageGen" : "videoGen")}
            />
          </Suspense>
        </div>
      )}
      {/* 短剧制作台：剧本→分镜→镜头→成片流水线（与媒体工作区共用实验开关） */}
      {dramaActive && (
        <div className="flex h-full min-w-0 flex-1 overflow-hidden" data-testid="drama-workspace-shell">
          <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>{mediaT("loadingMediaWorkspace")}</div>}>
            <DramaStudio />
          </Suspense>
        </div>
      )}
      {/* 技能市场：全屏浏览/安装 agent skills（keep-alive，保留搜索与分类状态）。
          挂 main-view-layer 与其余视图共用同一 cross-fade 过渡（见 index.css）。 */}
      {skillMarketEnabled && isMounted("skillMarket") && (
        <div
          className="main-view-layer flex-1 overflow-hidden"
          {...layerA11yAttrs("skillMarket")}
          {...viewMotionAttr("skillMarket")}
          style={{ background: "var(--app-panel-bg)", ...viewStyle("skillMarket") }}
          data-testid="skill-market-shell"
        >
          <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>{commonT("loading")}</div>}>
            <SkillMarketPage />
          </Suspense>
        </div>
      )}
      {/* Files 模式：文件编辑面板（侧边栏文件浏览器在上方共用 Sidebar） */}
      {isMounted("files") && (
        <div
          className="main-view-layer absolute inset-0 overflow-hidden"
          data-main-view="files"
          {...layerA11yAttrs("files")}
          {...viewMotionAttr("files")}
          style={{ background: "var(--app-panel-bg)", ...viewStyle("files") }}
        >
          <FileEditorPanel />
        </div>
      )}
      {/* 面板区域（终端）：keep-alive 关键区——隐藏不卸载，切回即恢复。
          壁纸激活时仅在此根节点覆盖 effective token（不动 :root，不污染 files 等视图），
          子树内画底的位置读 --app-panel-bg-effective 即透出壁纸层。 */}
      {isMounted("panes") && (
        <div
          className="main-view-layer absolute inset-0 flex flex-col overflow-hidden"
          data-main-view="panes"
          {...layerA11yAttrs("panes")}
          {...viewMotionAttr("panes")}
          style={{
            background: "var(--app-panel-bg)",
            ...(wallpaperActive
              ? ({
                  // 半透明垫层而非全透明：见 WALLPAPER_PANEL_BG_EFFECTIVE_* 注释。
                  "--app-panel-bg-effective": isDark
                    ? WALLPAPER_PANEL_BG_EFFECTIVE_DARK
                    : WALLPAPER_PANEL_BG_EFFECTIVE_LIGHT,
                  // 面板底一透，面板自己的 backdrop-filter 就直接糊在壁纸上——
                  // 壁纸的 blur 滑杆管不到这层，暗色主题默认 12px 会把视频糊没。
                  // 壁纸激活时由壁纸设置接管该 token（默认 8 = 轻磨砂垫层）。
                  "--app-glass-blur": `${wallpaperGlassBlur}px`,
                } as React.CSSProperties)
              : null),
            ...viewStyle("panes"),
          }}
        >
          <MainWallpaperLayer />
          {/* 亮色终端「脏交界」纯色垫层：压在壁纸层（z-0，同层后渲染者在上）之上、
              内容区（z-[1]）之下。亮色 + 终端主导 + 终端不透明时 opacity=1，
              内容区 80% 半透明的 --app-panel-bg-effective 落在其上复合为纯色面板底，
              与白底 xterm 的交界不再透壁纸。不随 appViewMode 开关——否则切回
              panes 时壁纸会先漏一帧（闪烁）；opacity 过渡保证主题/布局切换平滑。 */}
          <div
            aria-hidden="true"
            data-terminal-solid-underlay=""
            data-active={String(terminalSolidUnderlay)}
            className="absolute inset-0 z-0 pointer-events-none"
            style={{
              background: "var(--app-panel-bg)",
              opacity: terminalSolidUnderlay ? 1 : 0,
              transition:
                "opacity var(--dur) var(--ease-out), background-color var(--dur) var(--ease-out)",
            }}
          />
          {/* DndPaneProvider 必须同时包住布局条与面板区：dnd-kit 的碰撞检测只在
              同一个 DndContext 的 droppable registry 内做，布局条若在 context 外
              就永远接不到从面板区拖来的 tab。DndContext 不渲染 DOM 节点，flex
              布局不受影响。 */}
          <DndPaneProvider>
            {/* 布局条模式：标签上方多一层布局层（corner 模式下仍走左下角 LayoutBar）。
                抬到 z-[1]：壁纸层是 positioned z-0，静态流内容会被它盖住 */}
            {layoutSwitcherMode === "topbar" && (
              <div className="relative z-[1] shrink-0">
                <LayoutTopBar />
              </div>
            )}
            <div className="relative z-[1] min-h-0 flex-1 overflow-hidden">
              <div
                className="h-full w-full"
                style={{ display: canvasDisplayMode === "panel" ? "block" : "none" }}
                data-terminal-layout-view
              >
                {layouts.map((layout) => {
                  const isCurrent = layout.id === currentLayoutId;
                  return (
                    <LayoutVisibilityContext.Provider key={layout.id} value={isCurrent && isActive("panes") && canvasDisplayMode === "panel"}>
                      <div
                        className="h-full w-full"
                        style={{ display: isCurrent ? "block" : "none" }}
                      >
                        {layout.kind === "starred" ? (
                          <StarredPanel />
                        ) : (
                          <PaneContainer pane={isCurrent ? rootPane : layout.rootPane} />
                        )}
                      </div>
                    </LayoutVisibilityContext.Provider>
                  );
                })}
              </div>
              <div
                className="h-full w-full"
                style={{ display: canvasDisplayMode === "canvas" ? "block" : "none" }}
                data-terminal-canvas-view
              >
                <PaneFlowOverlay />
              </div>
            </div>
          </DndPaneProvider>
        </div>
      )}
      {/* 窄档侧栏浮出层：盖在主内容区上方（main 是 relative + overflow-hidden），
          不占布局宽度；scrim 点击即收起。宽档不渲染，行为与现状一致。 */}
      <SidebarFlyout
        open={isFlyout && shouldShowSidebar}
        onClose={() => setSidebarVisible(false)}
      >
        {isActive("todo") ? todoSidebar : (
          <Sidebar
            activeView={activeView}
            onOpenTerminal={onOpenTerminal}
          />
        )}
      </SidebarFlyout>
      </main>
      {showOrchestrationOverlay && (
        <OrchestrationOverlay onClose={closeOrchestrationOverlay} />
      )}
        </>
      )}
    </TodoManager>
  );
}
