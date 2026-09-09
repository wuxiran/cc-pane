import { useRef, useEffect, useCallback, useMemo, useState, forwardRef, useImperativeHandle, type CSSProperties } from "react";
// xterm 只作类型引用；构造器与 css 经 terminal/terminalXtermModules 动态装载。
import type { Terminal, IDisposable } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { useTranslation } from "react-i18next";
import { terminalService } from "@/services";
import type { TerminalHiddenWriteBuffer } from "./terminalHiddenWriteBuffer";
import { restoreVisibleTerminalView, type PendingSessionExit } from "./terminalSessionBinding";
import {
  normalizeTerminalFontSize,
  normalizeTerminalScrollback,
  useSettingsStore,
  useThemeStore,
  useWallpaperStore,
} from "@/stores";
import {
  useAggregateVisibilitySubscription,
  useDowngradeVisibility,
  useViewVisibilityEdgeSubscription,
  useViewVisibilityReaders,
} from "./useDowngradeVisibility";
import { useTerminalAppearanceSync } from "./useTerminalAppearanceSync";
import { useTerminalHibernation } from "./useTerminalHibernation";
import {
  resolveTerminalBufferMode,
  type TerminalDataRenderer,
} from "./terminalBufferMode";
import type { attachTerminalInputTrace } from "./terminalInputTrace";
import type { attachTerminalDomInputFallback } from "./terminalDomInputFallback";
import type { attachTerminalImeGuard } from "./terminalImeGuard";
import { createTerminalWriteFlowControl } from "./terminalWriteFlowControl";
import { resolveCliTool } from "./terminalLaunchIdentity";
import type { TerminalLayoutScheduler } from "./terminalLayoutScheduler";
import type { TerminalRendererController } from "./terminalRendererController";
import { resolveTerminalRendererModeForSession } from "./terminalRenderer";
import {
  getTerminalTheme,
  withTransparentTerminalBackground,
} from "./terminalTheme";
import { normalizeTerminalFontFamily } from "./terminalFont";
import TerminalContextMenu from "./TerminalContextMenu";
import TerminalZoomHud from "./TerminalZoomHud";
import { useTerminalContextMenuActions } from "./useTerminalContextMenuActions";
import { useTerminalWheelZoom } from "./useTerminalWheelZoom";
// 注意：resolveCliTool / resolveRuntimeKind / notifySessionClaimed 不从这里导入——
// 它们在 0.11.8 阶段 A 已被拆到 terminalLaunchIdentity / terminalSessionNotices。
import { normalizeTerminalCursorStyle } from "./terminalViewHelpers";
import type { TerminalViewProps } from "./terminal/terminalViewTypes";
import { disposeTerminalView } from "./terminal/terminalViewCleanup";
import { useTerminalDebugLog } from "./terminal/useTerminalDebugLog";
import { useTerminalRestoreLogger } from "./terminal/useTerminalRestoreLogger";
import { useTerminalDataPipeline } from "./terminal/useTerminalDataPipeline";
import { useTerminalSessionCallbacks } from "./terminal/useTerminalSessionCallbacks";
import { useTerminalLayoutEvents } from "./terminal/useTerminalLayoutEvents";
import { useTerminalWebglRecovery } from "./terminal/useTerminalWebglRecovery";
import { useTerminalDeferredRestore } from "./terminal/useTerminalDeferredRestore";
import { useTerminalInstanceInit } from "./terminal/useTerminalInstanceInit";
// 注意：@xterm/xterm/css/xterm.css 不再静态引入——它随 terminal/terminalXtermModules
// 的动态 import 与 xterm JS 同 chunk 取回，在构造 Terminal 前就绪，加载完成后样式一致。

import type { TerminalRendererMode, TerminalThemeMode } from "@/types";
import { bindTerminalWindowRecovery } from "./terminalWindowRecovery";
const IS_WINDOWS = typeof navigator !== "undefined" && navigator.platform.startsWith("Win");

// killSession 调用点白名单（web/test/killSessionAllowlist.test.ts）把本文件登记为
// 「创建竞态回滚」杀点（预算 4 处）：拆到 terminal/ 下的会话创建与延迟恢复模块
// 经这四个注入回滚本次刚建出的重复/孤儿 PTY，调用点本体不离开白名单文件。
const killDuplicateSessionAfterCreate = async (sessionId: string) => {
  await terminalService.killSession(sessionId).catch(console.error);
};
const killSessionOnUnmountedInit = (sessionId: string) => {
  terminalService.killSession(sessionId).catch(console.error);
};
const killDuplicateSessionAfterDeferredCreate = async (sessionId: string) => {
  await terminalService.killSession(sessionId).catch(console.error);
};
const killSessionOnUnmountedDeferredRestore = (sessionId: string) => {
  terminalService.killSession(sessionId).catch(console.error);
};

export interface TerminalViewHandle {
  focus: () => void;
  fit: () => void;
}

const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView(props, ref) {
    const { t } = useTranslation("panes");
    const drivesBackendPty = props.drivesBackendPty ?? true;
    const readOnlyRef = useRef(Boolean(props.readOnly)); const resizeBackendPtyRef = useRef(Boolean(props.resizeBackendPty));
    const isDark = useThemeStore((s) => s.isDark);
    const terminalThemeMode = useSettingsStore((s): TerminalThemeMode => s.settings?.terminal.themeMode ?? "followApp");
    const configuredTerminalFontSize = useSettingsStore((s) => normalizeTerminalFontSize(s.settings?.terminal.fontSize));
    const terminalFontFamily = useSettingsStore((s) => normalizeTerminalFontFamily(s.settings?.terminal.fontFamily));
    const terminalCursorStyle = useSettingsStore((s) => normalizeTerminalCursorStyle(s.settings?.terminal.cursorStyle));
    const terminalCursorBlink = useSettingsStore((s) => s.settings?.terminal.cursorBlink ?? false);
    const terminalScrollback = useSettingsStore((s) => normalizeTerminalScrollback(s.settings?.terminal.scrollback));
    // 壁纸终端透明度：原子数值 selector（壁纸未激活恒为 1，getTerminalTheme 返回原引用）。
    // 开关壁纸只走下方主题热更新路径，绝不重建终端。
    const wallpaperTerminalAlpha = useWallpaperStore((s) =>
      s.resolved !== null && s.assetUrl !== null ? s.resolved.terminalOpacity : 1,
    );
    const wallpaperTransparencyRequired = wallpaperTerminalAlpha < 1;
    const terminalTheme = useMemo(
      () => getTerminalTheme(isDark, terminalThemeMode, wallpaperTerminalAlpha),
      [isDark, terminalThemeMode, wallpaperTerminalAlpha],
    );
    // 底色由外层容器独占（见 withTransparentTerminalBackground 注释）：
    // xterm 侧一律用全透明 background，否则同一层 rgba 被画两遍。
    const xtermTheme = useMemo(
      () => withTransparentTerminalBackground(terminalTheme, wallpaperTerminalAlpha),
      [terminalTheme, wallpaperTerminalAlpha],
    );
    const terminalRef = useRef<HTMLDivElement>(null);
    const terminalFontSize = useTerminalWheelZoom(terminalRef, configuredTerminalFontSize, { initialFontSize: props.initialTerminalFontSize, persistenceKey: props.terminalZoomPersistenceKey });
    const terminalFontSizeRef = useRef(terminalFontSize);
    terminalFontSizeRef.current = terminalFontSize;
    const terminalInstanceRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const [terminalReady, setTerminalReady] = useState(false);
    // 后台休眠（docs/71 §3.1）：epoch 自增触发 init effect 重跑——休眠态跳过构造、
    // 唤醒态全量重建。休眠/唤醒状态机在 useTerminalHibernation。
    const [instanceEpoch, setInstanceEpoch] = useState(0);
    const serializeAddonRef = useRef<SerializeAddon | null>(null);
    const rendererControllerRef = useRef<TerminalRendererController | null>(null);
    const lastAppearanceFontRef = useRef<string | null>(null);
    const layoutSchedulerRef = useRef<TerminalLayoutScheduler | null>(null);
    const onDataDisposableRef = useRef<IDisposable | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const currentSessionIdRef = useRef<string | null>(null);
    const geometryEpochRef = useRef(0); const markExplicitGeometryChange = useCallback(() => { geometryEpochRef.current += 1; }, []);
    // 本视图自己的订阅注销函数：同一会话可能被多个视图订阅（星标镜像），
    // 卸载时只能注销自己这份，绝不能按 sessionId 全量 detach（会灭掉其他视图）。
    const outputUnsubRef = useRef<(() => void) | null>(null);
    const exitUnsubRef = useRef<(() => void) | null>(null);
    const desyncUnsubRef = useRef<(() => void) | null>(null);
    const pasteHandlerRef = useRef<((e: ClipboardEvent) => void) | null>(null);
    // 右键菜单"粘贴"入口：init 闭包里把 pasteTerminalPayload 暴露到这里。
    const pasteRequestRef = useRef<(() => void) | null>(null);
    const nativeMenuCleanupRef = useRef<(() => void) | null>(null);
    const inputDebugCleanupRef = useRef<(() => void) | null>(null);
    const inputTraceSeqRef = useRef(0);
    const lastShortcutPasteAtRef = useRef(0);
    const dragDropUnlistenRef = useRef<(() => void) | null>(null);
    const inputTraceRef = useRef<ReturnType<typeof attachTerminalInputTrace> | null>(null);
    const domInputFallbackRef = useRef<ReturnType<typeof attachTerminalDomInputFallback> | null>(null);
    const imeGuardRef = useRef<ReturnType<typeof attachTerminalImeGuard> | null>(null);
    const parserDisposableRefs = useRef<IDisposable[]>([]);
    const writeFlowControlRef = useRef<ReturnType<typeof createTerminalWriteFlowControl> | null>(null);
    const atlasResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastDevicePixelRatioRef = useRef(
      typeof window !== "undefined" ? window.devicePixelRatio : 1
    );
    const lastWebglRecoveryAtRef = useRef(0);
    const webglRecoveryStreakRef = useRef(0);

    // Track SSH reconnect state.
    const isDisconnectedRef = useRef(false);
    const isReconnectingRef = useRef(false);
    const isSshRef = useRef(!!props.ssh);
    const isUnmountedRef = useRef(false);
    // Delay PTY creation for hidden restored tabs until they become visible.
    const deferredRestoreRef = useRef(false);
    // True once this terminal has been mounted while its layout was inactive (hidden).
    // More robust hand-off signal than deferredRestoreRef: it is set purely from the
    // layoutActive prop, independent of whether the init effect reached its defer branch.
    const everHiddenRef = useRef(false);
    // Guards against double-launching the same tab from both the init-effect restore
    // path (current layout) and the activation fallback (previously-hidden layout).
    const restoreLaunchStartedRef = useRef(false);
    const { logRestoreEvent, reportRestoreLaunchState } = useTerminalRestoreLogger({
      tabId: props.tabId,
      paneId: props.paneId,
      projectPath: props.projectPath,
      layoutActive: props.layoutActive,
      restoring: props.restoring,
      everHiddenRef,
      deferredRestoreRef,
      currentSessionIdRef,
      restoreLaunchStartedRef,
      onRestoreLaunchState: props.onRestoreLaunchState,
    });

    const onSessionCreatedRef = useRef(props.onSessionCreated);
    const onSessionExitedRef = useRef(props.onSessionExited);
    const onLaunchErrorRef = useRef(props.onLaunchError);
    const onReconnectRef = useRef(props.onReconnect);
    const debugInstanceIdRef = useRef(`term-${Math.random().toString(36).slice(2, 8)}`);
    const trackedBufferTypeRef = useRef<"unknown" | "normal" | "alternate">("unknown");
    const focusReportModeRef = useRef(false);
    const lastDragFitAtRef = useRef(0);
    const layoutActiveRef = useRef(props.layoutActive ?? true);
    const hiddenWriteBufferRef = useRef<TerminalHiddenWriteBuffer | null>(null);
    const terminalRendererMode = useSettingsStore((s) => s.settings?.terminal.rendererMode ?? "auto");
    const effectiveCliTool = resolveCliTool(props.cliTool, props.launchClaude);
    // 托管 CLI 共用透明表面；普通 shell 保留原生 ANSI 背景（如 vim）。
    const transparentCliSurface = effectiveCliTool !== "none";
    const transparentCliSurfaceRef = useRef(transparentCliSurface);
    transparentCliSurfaceRef.current = transparentCliSurface;
    const resolveRendererMode = useCallback((mode: TerminalRendererMode) => {
      return resolveTerminalRendererModeForSession(mode, {
        cliToolId: effectiveCliTool,
        isWindows: IS_WINDOWS,
      });
    }, [effectiveCliTool]);
    const terminalRendererModeRef = useRef<TerminalRendererMode>(
      resolveTerminalRendererModeForSession(terminalRendererMode, {
        cliToolId: effectiveCliTool,
        isWindows: IS_WINDOWS,
      })
    );

    const debugLog = useTerminalDebugLog({
      paneId: props.paneId,
      tabId: props.tabId,
      projectPath: props.projectPath,
      sessionId: props.sessionId,
      layoutActive: props.layoutActive,
      effectiveCliTool,
      debugInstanceIdRef,
      currentSessionIdRef,
      rendererControllerRef,
      terminalInstanceRef,
    });
    const cliBufferModeOverrides = useSettingsStore(
      (s) => s.settings?.terminal.cliBufferModes ?? null,
    );
    const keepCliOutputInNormalBuffer =
      resolveTerminalBufferMode(effectiveCliTool, cliBufferModeOverrides) === "strip";
    // renderer 会扣留跨 chunk 的不完整序列尾部，必须按终端实例持有；销毁时
    // xterm 正在 dispose，不再 flush 最多 32 字节的残留。
    const terminalDataRendererRef = useRef<TerminalDataRenderer | null>(null);
    // renderer 只建一次，探针通过 ref 读取最新 cliTool。
    const effectiveCliToolProbeRef = useRef(effectiveCliTool);
    effectiveCliToolProbeRef.current = effectiveCliTool;

    /** desync 重同步闸门：置真期间实时输出改走积压，防 reset 抹掉快照外的新输出。 */
    const resyncInProgressRef = useRef(false);
    const overflowResyncRef = useRef<(() => Promise<boolean>) | null>(null);
    const pendingExitDuringResyncRef = useRef<PendingSessionExit | null>(null);

    const {
      renderTerminalData,
      renderCheckpointData,
      syncTrackedBufferType,
      repaintTerminal,
      refitAndRepaintTerminal,
      writeTerminalData,
      flushHiddenWrites,
    } = useTerminalDataPipeline({
      sessionId: props.sessionId,
      keepCliOutputInNormalBuffer,
      terminalInstanceRef,
      rendererControllerRef,
      layoutSchedulerRef,
      currentSessionIdRef,
      terminalDataRendererRef,
      effectiveCliToolProbeRef,
      transparentCliSurfaceRef,
      trackedBufferTypeRef,
      focusReportModeRef,
      writeFlowControlRef,
      hiddenWriteBufferRef,
      resyncInProgressRef,
      overflowResyncRef,
      debugLog,
    });

    // 本终端是否值得渲染 / tab 级焦点——单视图读侧（useViewVisibilityReaders）。
    // 后台标签只是 display:none 仍挂载，照单全收会让 N 个后台会话各压一份
    // parser + renderer 上主线程（docs/71 §3）。leaf 级焦点由 props.leafFocused
    // 组合：`isViewActive() && (props.leafFocused ?? true)`。
    const layoutOnlyFallback = useCallback(() => layoutActiveRef.current, []);
    const { isRenderVisible, isViewActive } = useViewVisibilityReaders(
      props.visibilityOwnerId,
      props.viewRole,
      layoutOnlyFallback,
    );

    const resolveDowngradeVisibility = useDowngradeVisibility(
      props.visibilityOwnerId,
      isRenderVisible,
    );

    const { shouldRunWebglRecovery, scheduleWebglRecovery } = useTerminalWebglRecovery({
      rendererControllerRef,
      layoutSchedulerRef,
      atlasResetTimerRef,
      lastDevicePixelRatioRef,
      lastWebglRecoveryAtRef,
      webglRecoveryStreakRef,
      isViewActive,
      isRenderVisible,
      leafFocused: props.leafFocused,
      debugLog,
    });

    // Expose imperative helpers to parent panes.
    useImperativeHandle(ref, () => ({
      focus: () => terminalInstanceRef.current?.focus(),
      fit: () => {
        refitAndRepaintTerminal("imperative.fit");
      },
    }), [refitAndRepaintTerminal]);

    const bumpInstanceEpoch = useCallback(() => {
      setInstanceEpoch((epoch) => epoch + 1);
    }, []);
    const { hibernatedStateRef, wakeStateRef, notifyVisibility } = useTerminalHibernation({
      terminalInstanceRef,
      currentSessionIdRef,
      serializeAddonRef,
      hiddenWriteBufferRef,
      rendererControllerRef,
      isReconnectingRef,
      isDisconnectedRef,
      debugLog,
      bumpInstanceEpoch,
    });

    // Keep callback refs in sync with the latest props.
    useEffect(() => {
      onSessionCreatedRef.current = props.onSessionCreated;
      onSessionExitedRef.current = props.onSessionExited;
      onLaunchErrorRef.current = props.onLaunchError;
      onReconnectRef.current = props.onReconnect;
      layoutActiveRef.current = props.layoutActive ?? true;
      // 积压补投两道防线（docs/78）：drain-on-push 管「可见性翻转与数据到达的
      // 竞态」；store 单视图边沿订阅（useViewVisibilityEdgeSubscription）管
      // 「静默会话本视图翻可见时的补投」。两者覆盖不同，删任一都丢字。
      // 后台分层降档（docs/71 §3.1）：5min 挂 WebGL，30min 休眠。幂等，可每次 render 调。
      // 判据是「任一视图可见」而非「本视图可见」，见 resolveDowngradeVisibility。
      // 注意本处只覆盖「自身 render 触发」的路径；别的视图变化（如切到星标页）
      // 不会让本组件 render，那条边沿由下面的 store 订阅补上。
      notifyVisibility(resolveDowngradeVisibility());
      readOnlyRef.current = Boolean(props.readOnly); resizeBackendPtyRef.current = Boolean(props.resizeBackendPty);
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.options.disableStdin = Boolean(props.readOnly);
      }
      if (props.layoutActive === false) {
        everHiddenRef.current = true;
      }
    });

    useAggregateVisibilitySubscription(props.visibilityOwnerId, notifyVisibility);

    // 单视图边沿补投积压并 refit；聚合边沿只负责降档/休眠。
    useViewVisibilityEdgeSubscription(
      props.visibilityOwnerId,
      props.viewRole,
      useCallback(
        (visible: boolean) => {
          if (!visible) return;
          void restoreVisibleTerminalView({
            flushHiddenWrites,
            isRenderVisible,
            scheduleRefit: () => layoutSchedulerRef.current?.schedule("view.visible-edge.refit", { allowInactive: true }),
          });
        },
        [flushHiddenWrites, isRenderVisible],
      ),
    );

    useEffect(() => {
      const effectiveRendererMode = resolveRendererMode(terminalRendererMode);
      terminalRendererModeRef.current = effectiveRendererMode;
      rendererControllerRef.current?.configure(effectiveRendererMode);
      layoutSchedulerRef.current?.schedule("settings.renderer-mode");
    }, [resolveRendererMode, terminalRendererMode]);

    // 壁纸透明需求翻转时重估渲染器（decideTerminalRenderer 经 provider 读到新值，
    // configure 按 reason 变化自动 disposeWebgl 降 DOM / 恢复）。依赖是布尔翻转，
    // 只在用户改设置/切工作空间时变化——不进入 resize/visibility/focus 等高频路径。
    const effectiveCliToolRef = useRef(effectiveCliTool);
    effectiveCliToolRef.current = effectiveCliTool;
    useEffect(() => {
      rendererControllerRef.current?.configure(terminalRendererModeRef.current);
    }, [wallpaperTransparencyRequired]);

    useTerminalLayoutEvents({ layoutActiveRef, layoutSchedulerRef, debugLog });

    const {
      unbindSessionCallbacks,
      bindSessionCallbacks,
      doReconnect,
    } = useTerminalSessionCallbacks({
      terminalInstanceRef,
      serializeAddonRef,
      layoutSchedulerRef,
      currentSessionIdRef,
      hiddenWriteBufferRef,
      outputUnsubRef,
      exitUnsubRef,
      desyncUnsubRef,
      resyncInProgressRef,
      overflowResyncRef,
      pendingExitDuringResyncRef,
      isSshRef,
      isDisconnectedRef,
      isReconnectingRef,
      onReconnectRef,
      onSessionExitedRef,
      keepCliOutputInNormalBuffer,
      isRenderVisible,
      renderTerminalData,
      renderCheckpointData,
      writeTerminalData,
      syncTrackedBufferType,
      flushHiddenWrites,
      debugLog,
    });

    // Dispose listeners, timers, observers, addons, and the terminal instance.
    const cleanup = useCallback(() => {
      disposeTerminalView(
        {
          onDataDisposableRef,
          currentSessionIdRef,
          atlasResetTimerRef,
          layoutSchedulerRef,
          resizeObserverRef,
          parserDisposableRefs,
          dragDropUnlistenRef,
          inputTraceRef,
          domInputFallbackRef,
          imeGuardRef,
          pasteHandlerRef,
          nativeMenuCleanupRef,
          inputDebugCleanupRef,
          pasteRequestRef,
          terminalInstanceRef,
          rendererControllerRef,
          fitAddonRef,
          serializeAddonRef,
          writeFlowControlRef,
          trackedBufferTypeRef,
          focusReportModeRef,
        },
        { debugLog, unbindSessionCallbacks },
      );
    }, [debugLog, unbindSessionCallbacks]);

    // Initialize xterm and create or attach the backend session.
    // 依赖 instanceEpoch：休眠/唤醒通过 epoch 自增触发整轮 teardown + 重建。
    useTerminalInstanceInit({
      props,
      t,
      instanceEpoch,
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
      killSessionOnUnmounted: killSessionOnUnmountedInit,
    });

    useTerminalAppearanceSync({
      terminalInstanceRef,
      layoutSchedulerRef,
      rendererControllerRef,
      lastAppearanceFontRef,
      xtermTheme,
      fontSize: terminalFontSize,
      fontFamily: terminalFontFamily,
      cursorStyle: terminalCursorStyle,
      cursorBlink: terminalCursorBlink,
      scrollback: terminalScrollback,
    });
    // 启动期字体晚就绪兜底：waitForTerminalFont 有 1.5s 超时，超时后终端会用
    // fallback 字体度量 cell 并 fit；主字体随后加载完成时没有任何触发点，
    // cols/rows 误差会被放大成好几列空白。首次 loadingdone 时清图集并强制重排。
    useEffect(() => {
      const fonts = typeof document === "undefined" ? undefined : document.fonts;
      if (!fonts?.addEventListener) return;

      const handleLoadingDone = () => {
        fonts.removeEventListener("loadingdone", handleLoadingDone);
        if (!terminalInstanceRef.current) return;
        rendererControllerRef.current?.clearTextureAtlas("fonts.loadingdone");
        layoutSchedulerRef.current?.schedule("fonts.loadingdone", { force: true });
      };
      fonts.addEventListener("loadingdone", handleLoadingDone);
      return () => fonts.removeEventListener("loadingdone", handleLoadingDone);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (!IS_WINDOWS) return;
      return bindTerminalWindowRecovery({
        isRenderVisible,
        getLayoutScheduler: () => layoutSchedulerRef.current,
        repaint: (reason) => rendererControllerRef.current?.repaint(reason),
        getLastDevicePixelRatio: () => lastDevicePixelRatioRef.current,
        shouldRunWebglRecovery,
        scheduleWebglRecovery,
      });
    }, [isRenderVisible, scheduleWebglRecovery, shouldRunWebglRecovery]);

    useTerminalDeferredRestore({
      props,
      terminalReady,
      drivesBackendPty,
      terminalInstanceRef,
      fitAddonRef,
      layoutSchedulerRef,
      currentSessionIdRef,
      deferredRestoreRef,
      everHiddenRef,
      restoreLaunchStartedRef,
      isUnmountedRef,
      geometryEpochRef,
      trackedBufferTypeRef,
      readOnlyRef,
      resizeBackendPtyRef,
      onSessionCreatedRef,
      onLaunchErrorRef,
      isRenderVisible,
      isViewActive,
      renderTerminalData,
      renderCheckpointData,
      writeTerminalData,
      syncTrackedBufferType,
      bindSessionCallbacks,
      unbindSessionCallbacks,
      debugLog,
      logRestoreEvent,
      reportRestoreLaunchState,
      killDuplicateSessionAfterCreate: killDuplicateSessionAfterDeferredCreate,
      killSessionOnUnmounted: killSessionOnUnmountedDeferredRestore,
    });

    const {
      getTerminalSelection,
      getMenuSessionId,
      handleMenuCopySelection,
      handleMenuSelectAll,
      handleMenuPaste,
      handleMenuFitTerminal,
      handleMenuFitAllTerminals,
      handleMenuRefreshTerminal,
      handleMenuResetBuffer,
      handleMenuCopySessionId,
      handleMenuClearBuffer,
      handleMenuCopyBuffer,
      handleMenuExportBuffer,
      handleMenuOpenProjectDir,
    } = useTerminalContextMenuActions({
      terminalRef: terminalInstanceRef,
      rendererControllerRef,
      pasteRequestRef,
      currentSessionIdRef,
      sessionId: props.sessionId,
      projectPath: props.projectPath,
      debugLog,
      refitAndRepaintTerminal,
      repaintTerminal,
      canResizeBackend: () => (drivesBackendPty && !readOnlyRef.current) || resizeBackendPtyRef.current,
      onExplicitGeometryChange: markExplicitGeometryChange,
      requestBufferResync: () => overflowResyncRef.current?.() ?? Promise.resolve(false),
    });

    return (
      <div
        className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden"
        style={{
          "--cc-terminal-bg": terminalTheme.background,
          "--cc-terminal-fg": terminalTheme.foreground,
          background: terminalTheme.background,
          color: terminalTheme.foreground,
          paddingTop: 'var(--notch-bar-height, 0px)',
        } as CSSProperties}
      >
        <TerminalContextMenu
          getSelection={getTerminalSelection}
          getSessionId={getMenuSessionId}
          onCopySelection={handleMenuCopySelection}
          onSelectAll={handleMenuSelectAll}
          onPaste={handleMenuPaste}
          onFitTerminal={handleMenuFitTerminal}
          onFitAllTerminals={handleMenuFitAllTerminals}
          onRefreshTerminal={handleMenuRefreshTerminal}
          onResetBuffer={
            // 只在本视图有权驱动 PTY 时提供：镜像/只读视图 reset 后无法触发 CLI 重绘，只会空屏。
            drivesBackendPty && !readOnlyRef.current ? handleMenuResetBuffer : undefined
          }
          onCopySessionId={handleMenuCopySessionId}
          onClearBuffer={handleMenuClearBuffer}
          onCopyBuffer={handleMenuCopyBuffer}
          onExportBuffer={handleMenuExportBuffer}
          onOpenProjectDir={props.projectPath ? handleMenuOpenProjectDir : undefined}
        >
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            {/* 这里不要再挂 onContextMenu：原生菜单已由 blockNativeTerminalMenu 在捕获阶段
                preventDefault 压制，而冒泡阶段 stopPropagation 会挡住外层 TerminalContextMenu
                （Radix 靠冒泡的 onContextMenu 打开）。 */}
            <div
              ref={terminalRef}
              className="cc-terminal-host h-full w-full overflow-hidden [&_.xterm]:h-full"
            />
            <TerminalZoomHud fontSize={terminalFontSize} />
          </div>
        </TerminalContextMenu>
      </div>
    );
  }
);

export default TerminalView;
