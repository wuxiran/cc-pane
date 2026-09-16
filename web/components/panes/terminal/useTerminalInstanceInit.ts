import { noteTerminalReplayProgress, registerTerminalReplayFailureHandler } from "../terminalReplayPresentation";
import { useEffect } from "react";
// xterm 类型静态导入，实例装配通过 loadXtermRuntime 懒加载。
import type { Terminal, IDisposable } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { TFunction } from "i18next";
import { terminalService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { noteTerminalGeometry } from "@/utils/terminalCast";
import {
  normalizeTerminalFontSize,
  normalizeTerminalScrollback,
  useSettingsStore,
} from "@/stores";
import { createTerminalSlotHolder } from "@/lib/terminalSlot";
import { collectHibernatedOutput } from "../useTerminalHibernation";
import type { HibernatedTerminalState } from "../terminalHibernation";
import { attachTerminalTuiWheelMultiplier } from "../terminalTuiWheelMultiplier";
import { createTerminalWriteFlowControl } from "../terminalWriteFlowControl";
import { registerRecoveryCheckpointSource } from "../terminalRecoveryCheckpoint";
import {
  createTerminalLayoutScheduler,
  type TerminalLayoutScheduler,
} from "../terminalLayoutScheduler";
// WebGL 随 xterm 懒加载；这里仅导入类型。
import type { TerminalRendererController } from "../terminalRendererController";
import { loadXtermRuntime } from "./terminalXtermModules";
import { getCachedWindowsBuildNumber } from "../terminalWindows";
import { createTerminalPathLinkIntegration } from "../terminalPathLinkRegistration";
import {
  applyTerminalElementTheme,
  normalizeTerminalCursorStyle,
  waitForTerminalFont,
} from "../terminalViewHelpers";
import { normalizeTerminalFontFamily } from "../terminalFont";
import type { TerminalThemePalette } from "../terminalTheme";
import type { attachTerminalInputTrace } from "../terminalInputTrace";
import type { attachTerminalDomInputFallback } from "../terminalDomInputFallback";
import type { attachTerminalImeGuard } from "../terminalImeGuard";
import type { CliTool, TerminalRendererMode } from "@/types";
import type { RestoreLaunchState } from "../terminalRestoreQueue";
import { registerTerminalParserHandlers } from "./terminalParserHandlers";
import { attachTerminalInputIntegration } from "./terminalInputIntegration";
import { attachTerminalImageAddon } from "./terminalImageAddon";
import { createTerminalOnDataHandler } from "./terminalOnDataHandler";
import { createTerminalResizeObserver } from "./terminalResizeObserver";
import { launchOrAttachTerminalSession } from "./terminalSessionLaunch";
import { MINIMUM_TERMINAL_CONTRAST_RATIO } from "../terminalContrast";
import type { TerminalViewProps } from "./terminalViewTypes";

const IS_WINDOWS = typeof navigator !== "undefined" && navigator.platform.startsWith("Win");

interface RefValue<T> {
  current: T;
}

export interface UseTerminalInstanceInitParams {
  props: TerminalViewProps;
  t: TFunction<"panes">;
  instanceEpoch: number;
  onRendererFailure: (error: Error) => void;
  isDark: boolean;
  xtermTheme: TerminalThemePalette;
  drivesBackendPty: boolean;
  terminalRef: RefValue<HTMLDivElement | null>;
  terminalFontSizeRef: RefValue<number>;
  terminalInstanceRef: RefValue<Terminal | null>;
  fitAddonRef: RefValue<FitAddon | null>;
  serializeAddonRef: RefValue<SerializeAddon | null>;
  rendererControllerRef: RefValue<TerminalRendererController | null>;
  terminalRendererModeRef: RefValue<TerminalRendererMode>;
  lastAppearanceFontRef: RefValue<string | null>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  onDataDisposableRef: RefValue<IDisposable | null>;
  resizeObserverRef: RefValue<ResizeObserver | null>;
  currentSessionIdRef: RefValue<string | null>;
  geometryEpochRef: RefValue<number>;
  pasteHandlerRef: RefValue<((e: ClipboardEvent) => void) | null>;
  pasteRequestRef: RefValue<(() => void) | null>;
  nativeMenuCleanupRef: RefValue<(() => void) | null>;
  inputDebugCleanupRef: RefValue<(() => void) | null>;
  inputTraceSeqRef: RefValue<number>;
  lastShortcutPasteAtRef: RefValue<number>;
  dragDropUnlistenRef: RefValue<(() => void) | null>;
  inputTraceRef: RefValue<ReturnType<typeof attachTerminalInputTrace> | null>;
  domInputFallbackRef: RefValue<ReturnType<typeof attachTerminalDomInputFallback> | null>;
  imeGuardRef: RefValue<ReturnType<typeof attachTerminalImeGuard> | null>;
  parserDisposableRefs: RefValue<IDisposable[]>;
  writeFlowControlRef: RefValue<ReturnType<typeof createTerminalWriteFlowControl> | null>;
  isDisconnectedRef: RefValue<boolean>;
  isReconnectingRef: RefValue<boolean>;
  isSshRef: RefValue<boolean>;
  isUnmountedRef: RefValue<boolean>;
  deferredRestoreRef: RefValue<boolean>;
  restoreLaunchStartedRef: RefValue<boolean>;
  readOnlyRef: RefValue<boolean>;
  resizeBackendPtyRef: RefValue<boolean>;
  trackedBufferTypeRef: RefValue<"unknown" | "normal" | "alternate">;
  focusReportModeRef: RefValue<boolean>;
  lastDragFitAtRef: RefValue<number>;
  transparentCliSurfaceRef: RefValue<boolean>;
  effectiveCliToolRef: RefValue<CliTool>;
  onSessionCreatedRef: RefValue<(sessionId: string) => void>;
  onSessionExitedRef: RefValue<((exitCode: number) => void) | undefined>;
  onLaunchErrorRef: RefValue<TerminalViewProps["onLaunchError"]>;
  onReconnectRef: RefValue<(() => Promise<string | null>) | undefined>;
  hibernatedStateRef: RefValue<HibernatedTerminalState | null>;
  wakeStateRef: RefValue<HibernatedTerminalState | null>;
  setTerminalReady: (ready: boolean) => void;
  isRenderVisible: () => boolean;
  isViewActive: () => boolean;
  repaintTerminal: (reason: string) => void;
  renderTerminalData: (data: string) => string;
  renderCheckpointData: (data: string) => string;
  writeTerminalData: (data: string, onWritten?: () => void) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  bindSessionCallbacks: (sessionId: string) => Promise<void>;
  unbindSessionCallbacks: () => void;
  doReconnect: () => void;
  cleanup: () => void;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  logRestoreEvent: (event: string, extra?: Record<string, unknown>) => void;
  reportRestoreLaunchState: (state: RestoreLaunchState) => void;
  /** 创建竞态回滚杀点（本体在白名单文件 TerminalView.tsx，注入至此）。 */
  killDuplicateSessionAfterCreate: (sessionId: string) => Promise<void>;
  killSessionOnUnmounted: (sessionId: string) => void;
}

/**
 * Initialize xterm and create or attach the backend session.
 * 依赖 instanceEpoch：休眠/唤醒通过 epoch 自增触发整轮 teardown + 重建。
 */
export function useTerminalInstanceInit({
  props,
  t,
  instanceEpoch,
  onRendererFailure,
  isDark,
  xtermTheme,
  drivesBackendPty,
  terminalRef,
  terminalFontSizeRef,
  terminalInstanceRef,
  fitAddonRef,
  serializeAddonRef,
  rendererControllerRef,
  terminalRendererModeRef,
  lastAppearanceFontRef,
  layoutSchedulerRef,
  onDataDisposableRef,
  resizeObserverRef,
  currentSessionIdRef,
  geometryEpochRef,
  pasteHandlerRef,
  pasteRequestRef,
  nativeMenuCleanupRef,
  inputDebugCleanupRef,
  inputTraceSeqRef,
  lastShortcutPasteAtRef,
  dragDropUnlistenRef,
  inputTraceRef,
  domInputFallbackRef,
  imeGuardRef,
  parserDisposableRefs,
  writeFlowControlRef,
  isDisconnectedRef,
  isReconnectingRef,
  isSshRef,
  isUnmountedRef,
  deferredRestoreRef,
  restoreLaunchStartedRef,
  readOnlyRef,
  resizeBackendPtyRef,
  trackedBufferTypeRef,
  focusReportModeRef,
  lastDragFitAtRef,
  transparentCliSurfaceRef,
  effectiveCliToolRef,
  onSessionCreatedRef,
  onSessionExitedRef,
  onLaunchErrorRef,
  onReconnectRef,
  hibernatedStateRef,
  wakeStateRef,
  setTerminalReady,
  isRenderVisible,
  isViewActive,
  repaintTerminal,
  renderTerminalData,
  renderCheckpointData,
  writeTerminalData,
  syncTrackedBufferType,
  bindSessionCallbacks,
  unbindSessionCallbacks,
  doReconnect,
  cleanup,
  debugLog,
  logRestoreEvent,
  reportRestoreLaunchState,
  killDuplicateSessionAfterCreate,
  killSessionOnUnmounted,
}: UseTerminalInstanceInitParams): void {
  useEffect(() => {
    if (!terminalRef.current) return;

    // 休眠态：不构造 xterm，仅挂轻量订阅把输出收进休眠容器（保序、有上限）。
    const hibernated = hibernatedStateRef.current;
    if (hibernated) {
      return collectHibernatedOutput({
        hibernated,
        renderTerminalData,
        currentSessionIdRef,
        isSshRef,
        onReconnectRef,
        isDisconnectedRef,
        onSessionExited: (exitCode) => onSessionExitedRef.current?.(exitCode),
      });
    }

    let isMounted = true; const initGeometryEpoch = geometryEpochRef.current;
    isUnmountedRef.current = false;
    debugLog("mount", {
      restoring: props.restoring ?? false,
      savedSessionId: props.savedSessionId ?? null,
      instanceEpoch,
    });

    // 创建槽位归 effect 所有，卸载时也能释放尚未结束的创建。
    const slot = createTerminalSlotHolder();

    const init = async () => {
      // xterm 加载与 Windows 版本、字体等待并行。
      const xtermRuntimePromise = loadXtermRuntime();

      // Read the Windows build number once so xterm can enable ConPTY tuning.
      let buildNumber = 0;
      if (navigator.platform.startsWith('Win')) {
        buildNumber = await getCachedWindowsBuildNumber();
      }

      if (!isMounted || !terminalRef.current) return;

      // Resolve the current font before allocating a terminal that may be unmounted.
      {
        const pending = useSettingsStore.getState().settings?.terminal;
        await waitForTerminalFont(
          normalizeTerminalFontSize(pending?.fontSize),
          normalizeTerminalFontFamily(pending?.fontFamily),
        );
        if (!isMounted || !terminalRef.current) return;
      }

      const {
        Terminal,
        FitAddon,
        SerializeAddon,
        Unicode11Addon,
        createTerminalRendererController,
      } = await xtermRuntimePromise;
      if (!isMounted || !terminalRef.current) return;

      const termSettings = useSettingsStore.getState().settings?.terminal;
      const scrollback = normalizeTerminalScrollback(termSettings?.scrollback);
      const fontSize = terminalFontSizeRef.current;
      const fontFamily = normalizeTerminalFontFamily(termSettings?.fontFamily);
      const cursorStyle = normalizeTerminalCursorStyle(termSettings?.cursorStyle);
      const cursorBlink = termSettings?.cursorBlink ?? false;
      // Seed the appearance baseline so the first real font change (after this
      // async terminal is created) is detected and clears the WebGL atlas.
      lastAppearanceFontRef.current = `${fontSize}|${fontFamily}`;
      const pathLinkIntegration = createTerminalPathLinkIntegration(
        !isTauriRuntime() || !IS_WINDOWS,
        () => currentSessionIdRef.current, () => isSshRef.current,
        () => useSettingsStore.getState().settings?.terminal.pathLinksEnabled ?? true,
        t,
      );
      const term = new Terminal({
        allowProposedApi: true,
        // 无条件常量化：若随壁纸设置开关，切壁纸就得重建终端（渲染生命周期红线）。
        // 恒开后开关壁纸只改主题 alpha；代价是不透明时的微小合成开销。
        allowTransparency: true,
        cursorBlink,
        cursorStyle,
        fastScrollSensitivity: 5,
        fontSize,
        // F7.1：xterm 按背景动态把跌破阈值的文字色推离背景，达标颜色保持原样——
        // 浅色主题下大量 ANSI 色（亮黄/亮青/亮白等）本就不可读，全靠此项兜底。
        // 阈值真源在 terminalContrast.ts，配套审计单测防止被调低或误删。
        minimumContrastRatio: MINIMUM_TERMINAL_CONTRAST_RATIO,
        rescaleOverlappingGlyphs: true,
        smoothScrollDuration: 0,
        scrollback,
        fontFamily,
        ...(navigator.platform.startsWith('Win') && buildNumber && buildNumber > 0 && {
          windowsPty: {
            backend: 'conpty' as const,
            buildNumber,
          },
        }),
        theme: xtermTheme, linkHandler: pathLinkIntegration.linkHandler,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // 休眠（Tier2）时把整个缓冲序列化成 VT 字符串（含全部 scrollback 与颜色）。
      const serialize = new SerializeAddon();
      term.loadAddon(serialize);
      serializeAddonRef.current = serialize;
      if (drivesBackendPty) registerRecoveryCheckpointSource(term, serialize, () => isMounted && !readOnlyRef.current);
      term.open(terminalRef.current);
      // 给开了鼠标上报的全屏 TUI 补足滚轮距离（xterm 会抑制小像素增量）。
      // 走官方钩子而不是自己挂监听——理由见 terminalTuiWheelMultiplier.ts。
      attachTerminalTuiWheelMultiplier(term);
      applyTerminalElementTheme(term, xtermTheme);
      focusReportModeRef.current = false;
      const onFailure = (error: Error) => {
        if (!isMounted || terminalInstanceRef.current !== term) return;
        writeFlowControlRef.current?.dispose(error.message);
        onRendererFailure(error);
      };
      writeFlowControlRef.current = createTerminalWriteFlowControl(term, {
        onStall: onFailure,
        onProgress: () => noteTerminalReplayProgress(term),
      });
      parserDisposableRefs.current.push({ dispose: registerTerminalReplayFailureHandler(term, onFailure) });
      terminalInstanceRef.current = term;
      fitAddonRef.current = fit;
      layoutSchedulerRef.current = createTerminalLayoutScheduler({
        getTerminal: () => terminalInstanceRef.current,
        getFitAddon: () => fitAddonRef.current,
        getHost: () => terminalRef.current,
        getSessionId: () => currentSessionIdRef.current,
        isActive: () => isViewActive() || (!drivesBackendPty && isRenderVisible()), // Mirrors fit locally; backend writes stay gated below.
        canResizeBackend: () => (drivesBackendPty && !readOnlyRef.current) || resizeBackendPtyRef.current,
        repaint: repaintTerminal,
        resizeBackend: (cols, rows) => {
          const sessionId = currentSessionIdRef.current;
          if (!sessionId || (readOnlyRef.current && !resizeBackendPtyRef.current)) return;
          // WebGL 诊断台录制：记下几何，回放才能几何对齐（否则 TUI 光标定位错位出假花）。
          noteTerminalGeometry(sessionId, cols, rows);
          void terminalService.resize({ sessionId, cols, rows }).catch((error) => {
            console.warn("[TerminalView] Failed to resize terminal:", error);
          });
        },
        logger: debugLog,
      });
      trackedBufferTypeRef.current = term.buffer.active.type;
      debugLog("xterm.ready", {
        scrollback,
        fontFamily,
        fontSize,
        cursorStyle,
        cursorBlink,
        isDark,
        initialBuffer: term.buffer.active.type,
        rendererMode: terminalRendererModeRef.current,
        writeFlowControl: "enabled",
      });

      parserDisposableRefs.current = registerTerminalParserHandlers({
        term,
        currentSessionIdRef,
        transparentCliSurfaceRef,
        effectiveCliToolRef,
        debugLog,
      });
      if (!isSshRef.current) parserDisposableRefs.current.push(pathLinkIntegration.register(term));

      // Use Unicode 11 widths so CJK and emoji render correctly.
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = "11";

      rendererControllerRef.current = createTerminalRendererController({
        term,
        logger: debugLog,
        onRendererChanged: (reason, diagnostics) => {
          debugLog("renderer.changed", {
            reason,
            ...diagnostics,
          });
          layoutSchedulerRef.current?.schedule(`renderer.${reason}`);
        },
      });
      rendererControllerRef.current.configure(terminalRendererModeRef.current);

      // F7.4：内联图片（OSC 1337 / SIXEL）按开关懒加载，默认关闭。
      // fire-and-forget：取回 ~700KB chunk 不阻塞终端启动；落定时若已卸载则不附着
      // （见 terminalImageAddon.ts）。addon 随 term.dispose() 一并销毁，无需另起 ref。
      if (useSettingsStore.getState().settings?.terminal.inlineImagesEnabled) {
        void attachTerminalImageAddon({ term, isMounted: () => isMounted, debugLog });
      }

      // 输入装配（粘贴 / 文本域+原生菜单 / 拖放 / 自定义键）集中到独立模块，
      // 共享 runtimeKind 与 SSH 宿主路径的诚实提示回调（F2）。
      attachTerminalInputIntegration({
        props,
        t,
        term,
        debugLog,
        getHost: () => terminalRef.current,
        isMounted: () => isMounted,
        pasteHandlerRef,
        pasteRequestRef,
        nativeMenuCleanupRef,
        inputDebugCleanupRef,
        inputTraceSeqRef,
        lastShortcutPasteAtRef,
        dragDropUnlistenRef,
        inputTraceRef,
        domInputFallbackRef,
        imeGuardRef,
        currentSessionIdRef,
        readOnlyRef,
        isDisconnectedRef,
      });

      // Fit once after the initial layout pass. Inactive/hidden tabs keep a
      // pending layout and flush it when they become visible.
      layoutSchedulerRef.current?.schedule("initial.fit");

      // Forward terminal input, with Enter-to-reconnect handling for SSH disconnects.
      onDataDisposableRef.current = term.onData(createTerminalOnDataHandler({
        debugLog,
        inputTraceSeqRef,
        domInputFallbackRef,
        inputTraceRef,
        focusReportModeRef,
        isDisconnectedRef,
        isReconnectingRef,
        currentSessionIdRef,
        readOnlyRef, doReconnect, t,
      }));

      // Keep pane dragging responsive without fitting on every pointer move.
      const observer = createTerminalResizeObserver({
        isMounted: () => isMounted,
        layoutSchedulerRef,
        lastDragFitAtRef,
      });
      observer.observe(terminalRef.current);

      resizeObserverRef.current = observer;
      syncTrackedBufferType("xterm.initialized");

      // Remember whether this terminal is backed by SSH for exit handling.
      isSshRef.current = !!props.ssh;
      setTerminalReady(true);

      // Create a new backend session or attach to an existing one.
      await launchOrAttachTerminalSession({
        props,
        term,
        slot,
        isMounted: () => isMounted,
        initGeometryEpoch,
        drivesBackendPty,
        currentSessionIdRef,
        wakeStateRef,
        geometryEpochRef,
        readOnlyRef,
        resizeBackendPtyRef,
        isSshRef,
        onReconnectRef,
        onSessionCreatedRef,
        onLaunchErrorRef,
        restoreLaunchStartedRef,
        deferredRestoreRef,
        layoutSchedulerRef,
        debugLog,
        logRestoreEvent,
        reportRestoreLaunchState,
        renderTerminalData,
        renderCheckpointData,
        writeTerminalData,
        syncTrackedBufferType,
        bindSessionCallbacks,
        unbindSessionCallbacks,
        killDuplicateSessionAfterCreate,
        killSessionOnUnmounted,
      });
    };

    init();

    return () => {
      isMounted = false;
      isUnmountedRef.current = true;
      // 槽位不得比组件活得长：create 永不落定时 finally 不会执行，只有这里能收。
      slot.release();
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceEpoch]);
}
