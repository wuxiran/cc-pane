import { useRef, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle, type CSSProperties } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { writeText as tauriWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { info as logInfo } from "@tauri-apps/plugin-log";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { terminalService, historyService, sessionRestoreService, filesystemService, providerService } from "@/services";
import { ensureListeners } from "@/services/terminalService";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage, toTerminalLaunchError } from "@/utils";
import type { TerminalLaunchError } from "@/types";
import { pickCreateSessionResumeId } from "./terminalResume";
import { devDebugLog } from "@/utils/devLogger";
import { captureTerminalWrite, noteTerminalGeometry } from "@/utils/terminalCast";
import { TERMINAL_APP_MENU_PASTE_EVENT } from "@/utils/appMenuPaste";
import {
  TERMINAL_LAYOUT_CHANGED_EVENT,
  shouldTerminalHandleKey,
  useShortcutsStore,
  useSettingsStore,
  usePanesStore,
  useThemeStore,
  useTerminalStatusStore,
  useWallpaperStore,
} from "@/stores";
import { isDragging } from "@/stores/splitDragState";
import { replayAttachedSession } from "./terminalReplay";
import { formatTerminalInitError } from "./terminalInitError";
import { buildCursorPositionReport } from "./terminalCpr";
import {
  buildKittyKeyboardProtocolReport,
  buildPrimaryDeviceAttributesReport,
} from "./terminalCapabilityReports";
import { buildOscColorReply } from "./terminalOscColor";
import {
  createTerminalDataRenderer,
  detectAlternateBufferTransitions,
  shouldKeepCliOutputInNormalBuffer,
  type TerminalDataRenderer,
} from "./terminalBufferMode";
import { formatTerminalFilePaths, resolveTerminalPastePayload } from "./terminalClipboard";
import { isDropInsideTerminalHost } from "./terminalDrop";
import { attachTerminalInputTrace, summarizeTerminalInputData } from "./terminalInputTrace";
import { attachTerminalDomInputFallback } from "./terminalDomInputFallback";
import { attachTerminalImeGuard, isLinuxWebKitImeEnvironment } from "./terminalImeGuard";
import { isTerminalCopyShortcut, isTerminalPasteShortcut } from "./terminalKeyboard";
import { detectFocusReportMode, isXtermFocusReportInput } from "./terminalFocusReport";
import { createTerminalWriteFlowControl } from "./terminalWriteFlowControl";
import { getCliInstallHint } from "./terminalCliInstallHint";
import {
  createTerminalLayoutScheduler,
  type TerminalLayoutScheduler,
} from "./terminalLayoutScheduler";
import {
  createTerminalRendererController,
  type TerminalRendererController,
} from "./terminalRendererController";
import {
  isRestoreLaunchCancelled,
  terminalRestoreLaunchQueue,
  type RestoreLaunchState,
} from "./terminalRestoreQueue";
import { resolveTerminalRendererModeForSession } from "./terminalRenderer";
import {
  getTerminalTheme,
  withTransparentTerminalBackground,
  type TerminalThemePalette,
} from "./terminalTheme";
import { normalizeTerminalFontFamily } from "./terminalFont";
import TerminalContextMenu from "./TerminalContextMenu";
import { buildTerminalExportFileName, serializeTerminalBuffer } from "./terminalBufferSnapshot";
import "@xterm/xterm/css/xterm.css";

/** Cache the Windows build number once per renderer process. */
let cachedBuildNumber: number | null = null;
let buildNumberPromise: Promise<number> | null = null;

async function getCachedBuildNumber(): Promise<number> {
  if (cachedBuildNumber !== null) return cachedBuildNumber;
  if (!buildNumberPromise) {
    buildNumberPromise = terminalService.getWindowsBuildNumber()
      .then((num) => { cachedBuildNumber = num; return num; })
      .catch(() => { cachedBuildNumber = 0; return 0; });
  }
  return buildNumberPromise;
}

import type { CliTool, CreateSessionRequest, SshConnectionInfo, TerminalRendererMode, TerminalThemeMode, WslLaunchInfo } from "@/types";

const TERMINAL_DEBUG = import.meta.env.DEV;
const IS_WINDOWS = typeof navigator !== "undefined" && navigator.platform.startsWith("Win");
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const DEFAULT_TERMINAL_FONT_SIZE = 15;
const MIN_TERMINAL_FONT_SIZE = 10;
const MAX_TERMINAL_FONT_SIZE = 32;
const DEFAULT_TERMINAL_SCROLLBACK = 20_000;
const WEBGL_HEARTBEAT_INTERVAL_MS = 30_000;
const WEBGL_SLEEP_GAP_MS = 75_000;
const WEBGL_RECOVERY_PROMOTION_WINDOW_MS = 12_000;
const TERMINAL_FONT_WAIT_TIMEOUT_MS = 1_500;

// Best-effort wait for the configured terminal font to be ready before the
// WebGL renderer rasterizes its first glyph atlas (otherwise the first paint
// uses a blurry fallback). `document.fonts.ready` alone only settles fonts the
// page already requested, so we also explicitly request the configured family.
// A timeout guarantees a never-resolving font load can't block the terminal.
async function waitForTerminalFont(fontSize: number, fontFamily: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;

  const loadFont = (async () => {
    try {
      await document.fonts.load(`${fontSize}px ${fontFamily}`);
    } catch {
      // Ignore parse/load failures; fall through to the readiness signal.
    }
    try {
      await document.fonts.ready;
    } catch {
      // Best-effort only.
    }
  })();

  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, TERMINAL_FONT_WAIT_TIMEOUT_MS);
  });

  await Promise.race([loadFont, timeout]);
}

type TerminalCursorStyle = "block" | "underline" | "bar";

function keyboardDebugPayload(event: KeyboardEvent, textarea: HTMLTextAreaElement): Record<string, unknown> {
  return {
    type: event.type,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    repeat: event.repeat,
    isComposing: event.isComposing,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    defaultPrevented: event.defaultPrevented,
    textareaValue: summarizeTerminalInputData(textarea.value),
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
  };
}

function inputDebugPayload(event: InputEvent, textarea: HTMLTextAreaElement): Record<string, unknown> {
  return {
    type: event.type,
    inputType: event.inputType,
    data: summarizeTerminalInputData(event.data),
    isComposing: event.isComposing,
    defaultPrevented: event.defaultPrevented,
    textareaValue: summarizeTerminalInputData(textarea.value),
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
  };
}

function compositionDebugPayload(event: CompositionEvent, textarea: HTMLTextAreaElement): Record<string, unknown> {
  return {
    type: event.type,
    data: summarizeTerminalInputData(event.data),
    defaultPrevented: event.defaultPrevented,
    textareaValue: summarizeTerminalInputData(textarea.value),
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
  };
}

function attachTerminalInputDebugLog(
  textarea: HTMLTextAreaElement,
  logger: (event: string, payload?: Record<string, unknown>) => void,
  nextSeq: () => number,
): () => void {
  const cleanups: Array<() => void> = [];
  const add = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ) => {
    textarea.addEventListener(type, handler as EventListener, true);
    cleanups.push(() => textarea.removeEventListener(type, handler as EventListener, true));
  };

  add("keydown", (event) => {
    logger("input.dom.keydown", {
      traceSeq: nextSeq(),
      ...keyboardDebugPayload(event as KeyboardEvent, textarea),
    });
  });
  add("beforeinput", (event) => {
    logger("input.dom.beforeinput", {
      traceSeq: nextSeq(),
      ...inputDebugPayload(event as InputEvent, textarea),
    });
  });
  add("input", (event) => {
    logger("input.dom.input", {
      traceSeq: nextSeq(),
      ...inputDebugPayload(event as InputEvent, textarea),
    });
  });
  add("compositionstart", (event) => {
    logger("input.dom.compositionstart", {
      traceSeq: nextSeq(),
      ...compositionDebugPayload(event as CompositionEvent, textarea),
    });
  });
  add("compositionupdate", (event) => {
    logger("input.dom.compositionupdate", {
      traceSeq: nextSeq(),
      ...compositionDebugPayload(event as CompositionEvent, textarea),
    });
  });
  add("compositionend", (event) => {
    logger("input.dom.compositionend", {
      traceSeq: nextSeq(),
      ...compositionDebugPayload(event as CompositionEvent, textarea),
    });
  });

  return () => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  };
}

function setMacosTerminalNativeFocus(focused: boolean): void {
  if (!IS_MAC || !isTauriRuntime()) return;
  void invoke("set_macos_terminal_focused", { focused }).catch(() => {});
}

function normalizeTerminalFontSize(value?: number | null): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE;
  const rounded = Math.round(value as number);
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, rounded));
}

function normalizeTerminalCursorStyle(value?: string | null): TerminalCursorStyle {
  return value === "underline" || value === "bar" ? value : "block";
}

function resolveCliTool(cliTool?: CliTool, launchClaude?: boolean): string {
  return cliTool ?? (launchClaude ? "claude" : "none");
}

function resolveRuntimeKind(
  ssh?: SshConnectionInfo,
  wsl?: WslLaunchInfo,
): "local" | "wsl" | "ssh" {
  if (ssh) return "ssh";
  if (wsl) return "wsl";
  return "local";
}

function findLiveSavedSessionId(savedSessionId?: string): string | null {
  if (!savedSessionId) return null;
  // 读共享状态缓存（useTerminalStatusStore，由 terminal-status 事件 + 定时刷新维护），
  // 不再每个 tab 各发一次 getAllStatus IPC。重启时几十个 tab 同时挂载会并发打几十次
  // get_all_terminal_status，把后端拖住，让后续 tab 卡在进启动队列前的这个 await，
  // 导致"放约 10 个就停"的恢复 stall。同步读内存 map 不会 hang，也消除了 IPC 扇出。
  // 缓存里没有（冷启动未命中）→ 视为非 live → 走 relaunch（队列），功能不丢。
  const info = useTerminalStatusStore.getState().statusMap.get(savedSessionId);
  return info && info.status !== "exited" ? savedSessionId : null;
}

function writeTerminalReply(
  sessionId: string | null,
  response: string,
  onError: (error: unknown) => void,
) {
  if (!sessionId) return;
  void terminalService.write(sessionId, response, { source: "system" }).catch(onError);
}

function applyTerminalElementTheme(
  term: Terminal | null,
  theme: TerminalThemePalette,
) {
  if (!term?.element) return;
  term.element.style.backgroundColor = theme.background;
  term.element.style.color = theme.foreground;
}

async function copyTerminalSelection(selection: string): Promise<void> {
  try {
    await tauriWriteText(selection);
    return;
  } catch {
    // Fall through to the browser clipboard API below.
  }

  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable");
  }

  await clipboard.writeText(selection);
}

interface TerminalViewProps {
  sessionId: string | null;
  projectId: string;
  projectPath: string;
  /** Whether this tab is the selected tab in its panel and is visible on screen. */
  isVisible?: boolean;
  /** Whether this terminal belongs to the currently focused pane. */
  isActive: boolean;
  /** Whether this terminal belongs to the current top-level layout. */
  layoutActive?: boolean;
  workspaceName?: string;
  providerId?: string;
  providerSelection?: CreateSessionRequest["providerSelection"];
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  resumeId?: string;
  skipMcp?: boolean;
  appendSystemPrompt?: string;
  /** 首启注入的用户 prompt；session 创建成功后经 clearTabInitialPrompt 清除，restore 路径不传 */
  initialPrompt?: string;
  /** per-launch YOLO 覆盖：undefined = 跟随 launch profile */
  yoloMode?: boolean;
  adapterOptions?: CreateSessionRequest["adapterOptions"];
  ssh?: SshConnectionInfo;
  wsl?: WslLaunchInfo;
  /** Whether the tab is restoring output from a saved session. */
  restoring?: boolean;
  /** Saved session id used to replay persisted terminal output. */
  savedSessionId?: string;
  /** Pane id used to clear restoring state after recovery finishes. */
  paneId?: string;
  /** Tab id used to clear restoring state after recovery finishes. */
  tabId?: string;
  onRestoreLaunchState?: (state: RestoreLaunchState) => void;
  onLaunchError?: (error: TerminalLaunchError) => void;
  onSessionCreated: (sessionId: string) => void;
  onSessionExited?: (exitCode: number) => void;
  /** Optional SSH reconnect callback for disconnected sessions. */
  onReconnect?: () => Promise<string | null>;
}

export interface TerminalViewHandle {
  focus: () => void;
  fit: () => void;
}

const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView(props, ref) {
    const { t } = useTranslation("panes");
    const isDark = useThemeStore((s) => s.isDark);
    const terminalThemeMode = useSettingsStore((s): TerminalThemeMode => s.settings?.terminal.themeMode ?? "followApp");
    const terminalFontSize = useSettingsStore((s) => normalizeTerminalFontSize(s.settings?.terminal.fontSize));
    const terminalFontFamily = useSettingsStore((s) => normalizeTerminalFontFamily(s.settings?.terminal.fontFamily));
    const terminalCursorStyle = useSettingsStore((s) => normalizeTerminalCursorStyle(s.settings?.terminal.cursorStyle));
    const terminalCursorBlink = useSettingsStore((s) => s.settings?.terminal.cursorBlink ?? false);
    // 壁纸终端透明度：原子数值 selector（壁纸未激活恒为 1，getTerminalTheme 返回原引用）。
    // 开关壁纸只走下方主题热更新路径，绝不重建终端。
    const wallpaperTerminalAlpha = useWallpaperStore((s) =>
      s.resolved !== null && s.assetUrl !== null ? s.resolved.terminalOpacity : 1,
    );
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
    const terminalInstanceRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const rendererControllerRef = useRef<TerminalRendererController | null>(null);
    const lastAppearanceFontRef = useRef<string | null>(null);
    const layoutSchedulerRef = useRef<TerminalLayoutScheduler | null>(null);
    const onDataDisposableRef = useRef<IDisposable | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const currentSessionIdRef = useRef<string | null>(null);
    // 本视图自己的订阅注销函数：同一会话可能被多个视图订阅（星标镜像），
    // 卸载时只能注销自己这份，绝不能按 sessionId 全量 detach（会灭掉其他视图）。
    const outputUnsubRef = useRef<(() => void) | null>(null);
    const exitUnsubRef = useRef<(() => void) | null>(null);
    const wheelHandlerRef = useRef<((e: WheelEvent) => void) | null>(null);
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
    const webglHeartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const lastDevicePixelRatioRef = useRef(
      typeof window !== "undefined" ? window.devicePixelRatio : 1
    );
    const lastWebglHeartbeatAtRef = useRef(Date.now());
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
    // Release-visible restore trace (lands in cc-panes.log, unlike dev-only debugLog).
    const logRestoreEvent = useCallback((event: string, extra: Record<string, unknown> = {}) => {
      void logInfo(
        `[layout-restore] ${event} ${JSON.stringify({
          tabId: props.tabId ?? null,
          paneId: props.paneId ?? null,
          project: props.projectPath ?? null,
          layoutActive: props.layoutActive ?? true,
          restoring: props.restoring ?? false,
          everHidden: everHiddenRef.current,
          deferred: deferredRestoreRef.current,
          hasSession: Boolean(currentSessionIdRef.current),
          launchStarted: restoreLaunchStartedRef.current,
          ...extra,
        })}`,
      ).catch(() => {});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.tabId, props.paneId, props.projectPath, props.layoutActive, props.restoring]);

    const onSessionCreatedRef = useRef(props.onSessionCreated);
    const onSessionExitedRef = useRef(props.onSessionExited);
    const onLaunchErrorRef = useRef(props.onLaunchError);
    const onReconnectRef = useRef(props.onReconnect);
    const debugInstanceIdRef = useRef(`term-${Math.random().toString(36).slice(2, 8)}`);
    const trackedBufferTypeRef = useRef<"unknown" | "normal" | "alternate">("unknown");
    const focusReportModeRef = useRef(false);
    const lastWheelDecisionRef = useRef<string | null>(null);
    const lastDragFitAtRef = useRef(0);
    const isActiveRef = useRef(props.isActive);
    const isVisibleRef = useRef(props.isVisible ?? props.isActive);
    const layoutActiveRef = useRef(props.layoutActive ?? true);
    const terminalRendererMode = useSettingsStore((s) => s.settings?.terminal.rendererMode ?? "auto");
    const effectiveCliTool = resolveCliTool(props.cliTool, props.launchClaude);
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

    const debugLog = useCallback((event: string, payload: Record<string, unknown> = {}) => {
      if (!TERMINAL_DEBUG) return;
      devDebugLog("terminal-debug", event, {
        instanceId: debugInstanceIdRef.current,
        paneId: props.paneId ?? null,
        tabId: props.tabId ?? null,
        projectPath: props.projectPath,
        propSessionId: props.sessionId ?? null,
        sessionId: currentSessionIdRef.current ?? props.sessionId ?? null,
        cliTool: effectiveCliTool,
        isActive: props.isActive,
        isVisible: props.isVisible ?? props.isActive,
        layoutActive: props.layoutActive ?? true,
        renderer: rendererControllerRef.current?.getActiveRenderer() ?? null,
        xtermBuffer: terminalInstanceRef.current?.buffer.active.type ?? null,
        ...payload,
      });
    }, [
      effectiveCliTool,
      props.isActive,
      props.isVisible,
      props.layoutActive,
      props.paneId,
      props.projectPath,
      props.sessionId,
      props.tabId,
    ]);
    const keepCliOutputInNormalBuffer = shouldKeepCliOutputInNormalBuffer(effectiveCliTool);
    // renderer 是**有状态**的（可能扣留跨 chunk 的不完整转义序列尾部），必须按终端实例
    // 用 ref 持有——useMemo 可能被 React 丢弃重算，扣留的尾部会随之丢失。
    //
    // 销毁时不 flush 残留：写入残留得挂进 init 闭包的 cleanup（终端销毁时序红线），
    // 且那时 xterm 正在 dispose，写入本就不安全。代价是会话结束时最多丢 32 字节的
    // 不完整转义序列尾部（MAX_PARTIAL_TAIL_LENGTH 上限）——远好于动渲染生命周期。
    const terminalDataRendererRef = useRef<TerminalDataRenderer | null>(null);
    const renderTerminalData = useCallback((data: string) => {
      terminalDataRendererRef.current ??= createTerminalDataRenderer();
      return terminalDataRendererRef.current.render(data, {
        keepCliOutputInNormalBuffer,
        sessionId: currentSessionIdRef.current,
      });
    }, [keepCliOutputInNormalBuffer]);

    const syncTrackedBufferType = useCallback((reason: string) => {
      const current = terminalInstanceRef.current?.buffer.active.type;
      const next =
        current === "alternate" || current === "normal"
          ? current
          : "unknown";
      if (trackedBufferTypeRef.current === next) return;
      const previous = trackedBufferTypeRef.current;
      trackedBufferTypeRef.current = next;
      lastWheelDecisionRef.current = null;
      debugLog("buffer.changed", {
        reason,
        previousBuffer: previous,
        nextBuffer: next,
      });
    }, [debugLog]);

    const repaintTerminal = useCallback((reason: string) => {
      const term = terminalInstanceRef.current;
      if (!term) return;

      const renderer = rendererControllerRef.current;
      if (renderer) {
        renderer.repaint(reason);
        return;
      }

      requestAnimationFrame(() => {
        if (terminalInstanceRef.current !== term) return;
        try {
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch (error) {
          debugLog("renderer.repaint.refresh.fail", {
            reason,
            error: getErrorMessage(error),
          });
        }
      });
    }, [debugLog]);

    const refitAndRepaintTerminal = useCallback((
      reason: string,
      options: { focusIfSafe?: boolean } = {},
    ): Terminal | null => {
      return layoutSchedulerRef.current?.flush(reason, options) ?? null;
    }, []);

    const writeTerminalData = useCallback(async (
      data: string,
      onWritten?: () => void,
    ) => {
      const flowControl = writeFlowControlRef.current;
      if (!flowControl) {
        throw new Error("Terminal write flow control is not initialized");
      }
      // WebGL 花屏诊断台录制钩子（未 arm 时为 no-op，见 utils/terminalCast）。
      captureTerminalWrite(currentSessionIdRef.current ?? props.sessionId ?? "unknown", data);
      await flowControl.write(data, onWritten);
    }, [props.sessionId]);

    const shouldRunWebglRecovery = useCallback(() => {
      const renderer = rendererControllerRef.current;
      return Boolean(
        IS_WINDOWS &&
        renderer?.getActiveRenderer() === "webgl" &&
        isActiveRef.current &&
        isVisibleRef.current &&
        layoutActiveRef.current
      );
    }, []);

    const scheduleWebglRecovery = useCallback((reason: string, options: { forceRecreate?: boolean } = {}) => {
      if (!shouldRunWebglRecovery()) return;
      if (atlasResetTimerRef.current) {
        clearTimeout(atlasResetTimerRef.current);
      }
      atlasResetTimerRef.current = setTimeout(() => {
        atlasResetTimerRef.current = null;
        if (!shouldRunWebglRecovery()) return;

        lastDevicePixelRatioRef.current = window.devicePixelRatio;
        const now = Date.now();
        const elapsedSinceRecovery = now - lastWebglRecoveryAtRef.current;
        webglRecoveryStreakRef.current =
          elapsedSinceRecovery <= WEBGL_RECOVERY_PROMOTION_WINDOW_MS
            ? webglRecoveryStreakRef.current + 1
            : 1;
        lastWebglRecoveryAtRef.current = now;

        const controller = rendererControllerRef.current;
        const shouldRecreate = options.forceRecreate || webglRecoveryStreakRef.current >= 3;
        if (shouldRecreate && controller?.recreateWebgl(`webgl.recovery.${reason}`)) {
          debugLog("webgl.renderer.recreate", {
            reason,
            streak: webglRecoveryStreakRef.current,
            forced: Boolean(options.forceRecreate),
            dpr: lastDevicePixelRatioRef.current,
          });
          // 重建成功后清零 streak：否则连续的 resize/focus/visible 事件会让 streak 一直 ≥3、
          // 反复重建 WebGL context（每次重建都新建一个 context），是撞满 ~16 上限的主要推手。
          webglRecoveryStreakRef.current = 0;
          layoutSchedulerRef.current?.schedule(`webgl.renderer.recreate.${reason}`, { force: true });
          return;
        }

        const didClear = controller?.clearTextureAtlas(`webgl.texture-atlas.${reason}`) ?? false;
        debugLog("webgl.texture-atlas.recover", {
          reason,
          didClear,
          streak: webglRecoveryStreakRef.current,
          dpr: lastDevicePixelRatioRef.current,
        });
        layoutSchedulerRef.current?.schedule(`webgl.texture-atlas.${reason}`);
      }, 225);
    }, [debugLog, shouldRunWebglRecovery]);

    // Expose imperative helpers to parent panes.
    useImperativeHandle(ref, () => ({
      focus: () => terminalInstanceRef.current?.focus(),
      fit: () => {
        refitAndRepaintTerminal("imperative.fit");
      },
    }), [refitAndRepaintTerminal]);

    // Keep callback refs in sync with the latest props.
    useEffect(() => {
      onSessionCreatedRef.current = props.onSessionCreated;
      onSessionExitedRef.current = props.onSessionExited;
      onLaunchErrorRef.current = props.onLaunchError;
      onReconnectRef.current = props.onReconnect;
      isActiveRef.current = props.isActive;
      isVisibleRef.current = props.isVisible ?? props.isActive;
      layoutActiveRef.current = props.layoutActive ?? true;
      if (props.layoutActive === false) {
        everHiddenRef.current = true;
      }
    });

    useEffect(() => {
      const effectiveRendererMode = resolveRendererMode(terminalRendererMode);
      terminalRendererModeRef.current = effectiveRendererMode;
      rendererControllerRef.current?.configure(effectiveRendererMode);
      layoutSchedulerRef.current?.schedule("settings.renderer-mode");
    }, [resolveRendererMode, terminalRendererMode]);

    // 壁纸透明需求翻转时重估渲染器（decideTerminalRenderer 经 provider 读到新值，
    // configure 按 reason 变化自动 disposeWebgl 降 DOM / 恢复）。依赖是布尔翻转，
    // 只在用户改设置/切工作空间时变化——不进入 resize/visibility/focus 等高频路径。
    const wallpaperTransparencyRequired = wallpaperTerminalAlpha < 1;
    useEffect(() => {
      rendererControllerRef.current?.configure(terminalRendererModeRef.current);
    }, [wallpaperTransparencyRequired]);

    useEffect(() => {
      if (typeof window === "undefined") return;

      const handleLayoutChanged = (event: Event) => {
        const reason =
          event instanceof CustomEvent && typeof event.detail?.reason === "string"
            ? event.detail.reason
            : "layout";
        // schedule 内部双 RAF 执行，保证 fit 落在 React commit 之后
        // （store 事件的 RAF 派发可能早于非批处理路径的 commit），连发事件自动合并。
        debugLog("layout-change.refit.schedule", { reason });
        layoutSchedulerRef.current?.schedule(`layout-change.${reason}`, { force: true });
      };

      window.addEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, handleLayoutChanged);
      return () => {
        window.removeEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, handleLayoutChanged);
      };
    }, [debugLog]);

    /** 注销本视图自己的输出/退出订阅（不影响同会话的其他视图） */
    const unbindSessionCallbacks = useCallback(() => {
      outputUnsubRef.current?.();
      outputUnsubRef.current = null;
      exitUnsubRef.current?.();
      exitUnsubRef.current = null;
    }, []);

    // Dispose listeners, timers, observers, addons, and the terminal instance.
    const cleanup = useCallback(() => {
      debugLog("cleanup.begin", {
        trackedBuffer: trackedBufferTypeRef.current,
      });
      if (onDataDisposableRef.current) {
        onDataDisposableRef.current.dispose();
        onDataDisposableRef.current = null;
      }
      if (currentSessionIdRef.current) {
        debugLog("cleanup.detach-session", {
          detachSessionId: currentSessionIdRef.current,
        });
        currentSessionIdRef.current = null;
      }
      unbindSessionCallbacks();
      if (atlasResetTimerRef.current) {
        clearTimeout(atlasResetTimerRef.current);
        atlasResetTimerRef.current = null;
      }
      if (webglHeartbeatTimerRef.current) {
        clearInterval(webglHeartbeatTimerRef.current);
        webglHeartbeatTimerRef.current = null;
      }
      layoutSchedulerRef.current?.dispose();
      layoutSchedulerRef.current = null;
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (parserDisposableRefs.current.length > 0) {
        for (const disposable of parserDisposableRefs.current) {
          try {
            disposable.dispose();
          } catch {
            // Safe to ignore if parser handler was already disposed.
          }
        }
        parserDisposableRefs.current = [];
      }

      if (dragDropUnlistenRef.current) {
        try {
          dragDropUnlistenRef.current();
        } catch {
          // Safe to ignore if Tauri already removed the drag-drop listener.
        }
        dragDropUnlistenRef.current = null;
      }
      inputTraceRef.current?.dispose();
      inputTraceRef.current = null;
      domInputFallbackRef.current?.dispose();
      domInputFallbackRef.current = null;
      imeGuardRef.current?.dispose();
      imeGuardRef.current = null;

      // Remove the wheel handler before disposing xterm.
      if (wheelHandlerRef.current && terminalInstanceRef.current?.element) {
        terminalInstanceRef.current.element.removeEventListener('wheel', wheelHandlerRef.current);
        wheelHandlerRef.current = null;
      }
      if (pasteHandlerRef.current && terminalInstanceRef.current?.textarea) {
        terminalInstanceRef.current.textarea.removeEventListener('paste', pasteHandlerRef.current, true);
        pasteHandlerRef.current = null;
      }
      nativeMenuCleanupRef.current?.();
      nativeMenuCleanupRef.current = null;
      inputDebugCleanupRef.current?.();
      inputDebugCleanupRef.current = null;
      pasteRequestRef.current = null;

      // Dispose addons before the terminal instance.
      const rendererToDispose = rendererControllerRef.current;
      const fitToDispose = fitAddonRef.current;
      const termToDispose = terminalInstanceRef.current;
      terminalInstanceRef.current = null;
      rendererControllerRef.current = null;
      fitAddonRef.current = null;
      writeFlowControlRef.current?.reset();
      writeFlowControlRef.current = null;
      trackedBufferTypeRef.current = "unknown";
      focusReportModeRef.current = false;
      lastWheelDecisionRef.current = null;

      rendererToDispose?.dispose();
      if (fitToDispose) {
        try {
          fitToDispose.dispose();
        } catch {
          // Safe to ignore if the addon is already detached from the DOM.
        }
      }
      if (termToDispose) {
        try {
          termToDispose.dispose();
        } catch {
          // Safe to ignore if xterm was already detached from the DOM.
        }
      }
      debugLog("cleanup.end", {});
    }, [debugLog, unbindSessionCallbacks]);

    /** Shared exit handling for initial attach and reconnect flows. */
    const handleSessionExit = useCallback((sessionId: string, exitCode: number) => {
      console.warn(`[TerminalView] Session exited: ${sessionId}, exitCode=${exitCode}`);
      const term = terminalInstanceRef.current;
      if (!term) return;
      term.writeln(`\r\n\x1b[33mProcess exited with code ${exitCode}\x1b[0m`);

      // Show reconnect hints after an SSH disconnect.
      if (isSshRef.current && onReconnectRef.current) {
        term.writeln(
          "\x1b[36m[Disconnected] Press Enter to reconnect, or Ctrl+C to close.\x1b[0m"
        );
        isDisconnectedRef.current = true;
      }

      onSessionExitedRef.current?.(exitCode);
    }, []);

    /** Attach output and exit listeners for a session. */
    const bindSessionCallbacks = useCallback(async (sessionId: string) => {
      debugLog("session.bind-callbacks.begin", {
        bindSessionId: sessionId,
      });
      // 换绑前先注销旧订阅（重连等场景），避免旧回调残留
      unbindSessionCallbacks();
      outputUnsubRef.current = await terminalService.registerOutput(sessionId, (data) => {
        const term = terminalInstanceRef.current;
        const focusReportMode = detectFocusReportMode(data, focusReportModeRef.current);
        if (focusReportMode !== focusReportModeRef.current) {
          debugLog("output.focus-report-mode.changed", {
            bindSessionId: sessionId,
            enabled: focusReportMode,
          });
          focusReportModeRef.current = focusReportMode;
        }
        const transitions = detectAlternateBufferTransitions(data);
        const renderedData = renderTerminalData(data);
        if (transitions.length > 0) {
          debugLog("output.alternate-sequence.received", {
            bindSessionId: sessionId,
            transitions,
            dataLength: data.length,
            renderedDataLength: renderedData.length,
            stripped: keepCliOutputInNormalBuffer,
          });
        }

        if (!term) {
          debugLog("output.write.skipped", {
            bindSessionId: sessionId,
            dataLength: data.length,
            transitions,
          });
          return;
        }

        if (!renderedData) {
          syncTrackedBufferType(
            transitions.length > 0 ? "output.alternate-sequence.stripped" : "output.empty"
          );
          return;
        }

        void writeTerminalData(renderedData, () => {
          if (transitions.length > 0) {
            debugLog("output.alternate-sequence.applied", {
              bindSessionId: sessionId,
              transitions,
              bufferAfter: term.buffer.active.type,
              stripped: keepCliOutputInNormalBuffer,
            });
          }
          syncTrackedBufferType(
            transitions.length > 0 ? "output.alternate-sequence" : "output.write"
          );
        }).catch((error) => {
          debugLog("output.write.failed", {
            bindSessionId: sessionId,
            dataLength: data.length,
            error: getErrorMessage(error),
          });
        });
      });
      exitUnsubRef.current = await terminalService.registerExit(sessionId, (exitCode) => {
        handleSessionExit(sessionId, exitCode);
      });
      debugLog("session.bind-callbacks.end", {
        bindSessionId: sessionId,
      });
    }, [
      debugLog,
      handleSessionExit,
      keepCliOutputInNormalBuffer,
      renderTerminalData,
      syncTrackedBufferType,
      unbindSessionCallbacks,
      writeTerminalData,
    ]);

    /** Attempt to reconnect an SSH-backed session. */
    const doReconnect = useCallback(async () => {
      const term = terminalInstanceRef.current;
      if (!term || isReconnectingRef.current) return;
      const onReconnect = onReconnectRef.current;
      if (!onReconnect) return;

      isReconnectingRef.current = true;
      term.writeln("\r\n\x1b[33mReconnecting...\x1b[0m");

      try {
        // Detach callbacks from the previous session before reconnecting.
        unbindSessionCallbacks();

        const newSessionId = await onReconnect();
        if (!newSessionId) {
          term.writeln("\x1b[31mReconnection failed.\x1b[0m");
          term.writeln(
            "\x1b[36mPress Enter to retry.\x1b[0m"
          );
          isReconnectingRef.current = false;
          return;
        }

        currentSessionIdRef.current = newSessionId;
        term.writeln("\r\n\x1b[32m--- Reconnected ---\x1b[0m\r\n");

        // Attach callbacks to the new session.
        await bindSessionCallbacks(newSessionId);

        // Keep the backend PTY size aligned with the current terminal size.
        terminalService.resize({
          sessionId: newSessionId,
          cols: term.cols,
          rows: term.rows,
        });

        isDisconnectedRef.current = false;
        isReconnectingRef.current = false;
      } catch (error) {
        console.error("[TerminalView] Reconnection failed:", error);
        term.writeln(
          `\r\n\x1b[31mReconnection failed: ${getErrorMessage(error)}\x1b[0m`
        );
        term.writeln(
          "\x1b[36mPress Enter to retry.\x1b[0m"
        );
        isReconnectingRef.current = false;
      }
    }, [bindSessionCallbacks, unbindSessionCallbacks]);

    // Initialize xterm and create or attach the backend session.
    useEffect(() => {
      if (!terminalRef.current) return;

      let isMounted = true;
      isUnmountedRef.current = false;
      debugLog("mount", {
        restoring: props.restoring ?? false,
        savedSessionId: props.savedSessionId ?? null,
      });

      const init = async () => {
        // Read the Windows build number once so xterm can enable ConPTY tuning.
        let buildNumber = 0;
        if (navigator.platform.startsWith('Win')) {
          buildNumber = await getCachedBuildNumber();
        }

        if (!isMounted || !terminalRef.current) return;

        // Wait for the configured font *before* constructing the terminal, so an
        // unmount mid-await can't leak an unopened Terminal, and settings are
        // re-read afterwards so a font change during the wait is not lost.
        {
          const pending = useSettingsStore.getState().settings?.terminal;
          await waitForTerminalFont(
            normalizeTerminalFontSize(pending?.fontSize),
            normalizeTerminalFontFamily(pending?.fontFamily),
          );
          if (!isMounted || !terminalRef.current) return;
        }

        const termSettings = useSettingsStore.getState().settings?.terminal;
        const scrollback = termSettings?.scrollback ?? DEFAULT_TERMINAL_SCROLLBACK;
        const fontSize = normalizeTerminalFontSize(termSettings?.fontSize);
        const fontFamily = normalizeTerminalFontFamily(termSettings?.fontFamily);
        const cursorStyle = normalizeTerminalCursorStyle(termSettings?.cursorStyle);
        const cursorBlink = termSettings?.cursorBlink ?? false;
        // Seed the appearance baseline so the first real font change (after this
        // async terminal is created) is detected and clears the WebGL atlas.
        lastAppearanceFontRef.current = `${fontSize}|${fontFamily}`;
        const term = new Terminal({
          allowProposedApi: true,
          // 无条件常量化：若随壁纸设置开关，切壁纸就得重建终端（渲染生命周期红线）。
          // 恒开后开关壁纸只改主题 alpha；代价是不透明时的微小合成开销。
          allowTransparency: true,
          cursorBlink,
          cursorStyle,
          fastScrollSensitivity: 5,
          fontSize,
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
          theme: xtermTheme,
        });

        const fit = new FitAddon();
        term.loadAddon(fit);

        term.open(terminalRef.current);
        applyTerminalElementTheme(term, xtermTheme);
        focusReportModeRef.current = false;
        writeFlowControlRef.current = createTerminalWriteFlowControl(term, {
          enabled: IS_WINDOWS,
        });
        terminalInstanceRef.current = term;
        fitAddonRef.current = fit;
        layoutSchedulerRef.current = createTerminalLayoutScheduler({
          getTerminal: () => terminalInstanceRef.current,
          getFitAddon: () => fitAddonRef.current,
          getHost: () => terminalRef.current,
          getSessionId: () => currentSessionIdRef.current,
          isActive: () => isActiveRef.current,
          repaint: repaintTerminal,
          resizeBackend: (cols, rows) => {
            const sessionId = currentSessionIdRef.current;
            if (!sessionId) return;
            // WebGL 诊断台录制：记下几何，回放才能几何对齐（否则 TUI 光标定位错位出假花）。
            noteTerminalGeometry(sessionId, cols, rows);
            terminalService.resize({ sessionId, cols, rows });
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
          writeFlowControl: IS_WINDOWS ? "enabled" : "disabled",
        });

        const handleCursorPositionReport = (prefix?: string) => (params: (number | number[])[]) => {
          const sessionId = currentSessionIdRef.current;
          if (!sessionId) return false;
          const response = buildCursorPositionReport(
            params,
            prefix,
            term.buffer.active.cursorX,
            term.buffer.active.cursorY,
          );
          if (!response) return false;

          debugLog("terminal.cpr.reply", {
            sessionId,
            prefix: prefix ?? "",
            params,
            response,
          });
          void terminalService.write(sessionId, response, { source: "system" }).catch((error) => {
            console.warn("[TerminalView] Failed to send CPR response:", error);
          });
          return true;
        };
        const handleOscColorQuery = (ident: number) => (data: string) => {
          const sessionId = currentSessionIdRef.current;
          const response = buildOscColorReply(
            ident,
            data,
            getTerminalTheme(
              useThemeStore.getState().isDark,
              useSettingsStore.getState().settings?.terminal.themeMode,
            ),
          );
          debugLog("terminal.osc.query", {
            sessionId,
            ident,
            data,
            handled: Boolean(response),
          });
          if (!response) return false;

          writeTerminalReply(sessionId, response, (error) => {
            console.warn("[TerminalView] Failed to send OSC color response:", error);
          });
          debugLog("terminal.osc.reply", {
            sessionId,
            ident,
            data,
            response,
          });
          return true;
        };
        const handlePrimaryDeviceAttributesReport = (prefix?: string) => (params: (number | number[])[]) => {
          const sessionId = currentSessionIdRef.current;
          const response = buildPrimaryDeviceAttributesReport(params, prefix);
          debugLog("terminal.da.query", {
            sessionId,
            prefix: prefix ?? "",
            params,
            handled: Boolean(response),
          });
          if (!response) return false;

          writeTerminalReply(sessionId, response, (error) => {
            console.warn("[TerminalView] Failed to send DA response:", error);
          });
          return true;
        };
        const handleKittyKeyboardProtocolQuery = (prefix?: string) => (params: (number | number[])[]) => {
          const sessionId = currentSessionIdRef.current;
          const response = buildKittyKeyboardProtocolReport(params, prefix);
          debugLog("terminal.kitty-keyboard.query", {
            sessionId,
            prefix: prefix ?? "",
            params,
            handled: Boolean(response),
          });
          if (!response) return false;

          writeTerminalReply(sessionId, response, (error) => {
            console.warn("[TerminalView] Failed to send Kitty keyboard protocol response:", error);
          });
          return true;
        };
        parserDisposableRefs.current = [
          term.parser.registerCsiHandler({ final: "n" }, handleCursorPositionReport()),
          term.parser.registerCsiHandler({ prefix: "?", final: "n" }, handleCursorPositionReport("?")),
          term.parser.registerCsiHandler({ final: "c" }, handlePrimaryDeviceAttributesReport()),
          term.parser.registerCsiHandler({ prefix: "?", final: "u" }, handleKittyKeyboardProtocolQuery("?")),
          term.parser.registerOscHandler(4, handleOscColorQuery(4)),
          term.parser.registerOscHandler(10, handleOscColorQuery(10)),
          term.parser.registerOscHandler(11, handleOscColorQuery(11)),
        ];

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

        const pasteTextIntoTerminal = (text: string, kind: string) => {
          if (!text) return;
          debugLog("clipboard.paste", {
            kind,
            textLength: text.length,
          });
          imeGuardRef.current?.clearNativeEditState("before-paste");
          term.focus();
          term.paste(text);
          imeGuardRef.current?.clearNativeEditState("after-paste");
        };

        const pasteTerminalPayload = (clipboardData?: DataTransfer | null) => {
          if (!clipboardData) {
            const now = Date.now();
            if (now - lastShortcutPasteAtRef.current < 300) {
              debugLog("clipboard.paste.dedupe", {
                elapsedMs: now - lastShortcutPasteAtRef.current,
              });
              return;
            }
            lastShortcutPasteAtRef.current = now;
          }
          void resolveTerminalPastePayload(clipboardData)
            .then((payload) => {
              if (payload.kind === "image" || payload.kind === "text" || payload.kind === "file") {
                pasteTextIntoTerminal(payload.text, payload.kind);
                return;
              }

              if (payload.kind === "error") {
                debugLog("clipboard.paste.failed", {
                  reason: payload.reason,
                  error: payload.error,
                });
                toast.error(`Paste failed: ${payload.error}`);
              }
            })
            .catch((error) => {
              const message = getErrorMessage(error);
              debugLog("clipboard.paste.failed", {
                reason: "unexpected-error",
                error: message,
              });
              toast.error(`Paste failed: ${message}`);
            });
        };

        pasteRequestRef.current = () => pasteTerminalPayload(null);

        // Track terminal focus so global shortcuts can defer to xterm.
        const textarea = term.textarea;
        const cleanupNativeMenuBlockers: Array<() => void> = [];
        const isNativeMenuTrigger = (event: Event) => {
          if (!IS_MAC) return false;
          if (event.type === "contextmenu" || event.type === "auxclick") return true;
          if ("button" in event && typeof event.button === "number") {
            const ctrlKey = "ctrlKey" in event && event.ctrlKey === true;
            return event.button === 2 || (IS_MAC && ctrlKey && event.button === 0);
          }
          return false;
        };
        const blockNativeTerminalMenu = (event: Event) => {
          if (!isNativeMenuTrigger(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          term.focus();
          debugLog("native-menu.blocked", {
            eventType: event.type,
            target: event.target instanceof HTMLElement ? event.target.tagName : null,
          });
        };
        const addNativeMenuBlocker = (target: EventTarget | null | undefined) => {
          if (!target) return;
          for (const eventName of ["pointerdown", "mousedown", "mouseup", "auxclick", "contextmenu"]) {
            target.addEventListener(eventName, blockNativeTerminalMenu, true);
          }
          cleanupNativeMenuBlockers.push(() => {
            for (const eventName of ["pointerdown", "mousedown", "mouseup", "auxclick", "contextmenu"]) {
              target.removeEventListener(eventName, blockNativeTerminalMenu, true);
            }
          });
        };
        if (IS_MAC) {
          addNativeMenuBlocker(terminalRef.current);
          addNativeMenuBlocker(term.element);
        }

        if (textarea) {
          textarea.spellcheck = false;
          textarea.autocomplete = "off";
          textarea.autocapitalize = "off";
          textarea.setAttribute("autocorrect", "off");
          textarea.setAttribute("data-cc-panes-terminal-input", "true");
          const keydownPasteHandler = (event: KeyboardEvent) => {
            if (event.target !== textarea) return;
            if (!isTerminalPasteShortcut(event, IS_MAC)) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            debugLog("clipboard.paste-shortcut.captured", {
              key: event.key,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              altKey: event.altKey,
              shiftKey: event.shiftKey,
            });
            pasteTerminalPayload(null);
          };
          const appMenuPasteHandler = (event: Event) => {
            debugLog("clipboard.paste-menu.captured", {
              source: event instanceof CustomEvent ? event.detail?.source ?? "unknown" : "unknown",
            });
            pasteTerminalPayload(null);
          };
          const setFocused = useShortcutsStore.getState().setTerminalFocused;
          textarea.addEventListener('focus', () => {
            setFocused(true);
            setMacosTerminalNativeFocus(true);
            debugLog("textarea.focus", {});
          });
          textarea.addEventListener('blur', () => {
            setFocused(false);
            setMacosTerminalNativeFocus(false);
            debugLog("textarea.blur", {});
          });

          const pasteHandler = (e: ClipboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            pasteTerminalPayload(e.clipboardData);
          };

          textarea.ownerDocument.addEventListener("keydown", keydownPasteHandler, true);
          cleanupNativeMenuBlockers.push(() => {
            textarea.ownerDocument.removeEventListener("keydown", keydownPasteHandler, true);
          });
          textarea.addEventListener(TERMINAL_APP_MENU_PASTE_EVENT, appMenuPasteHandler);
          cleanupNativeMenuBlockers.push(() => {
            textarea.removeEventListener(TERMINAL_APP_MENU_PASTE_EVENT, appMenuPasteHandler);
          });
          textarea.addEventListener('paste', pasteHandler, true);
          pasteHandlerRef.current = pasteHandler;
          if (IS_MAC) {
            addNativeMenuBlocker(textarea);
          }
          inputDebugCleanupRef.current = attachTerminalInputDebugLog(
            textarea,
            debugLog,
            () => ++inputTraceSeqRef.current,
          );
          inputTraceRef.current = attachTerminalInputTrace({
            textarea,
            isDev: TERMINAL_DEBUG,
            isMac: IS_MAC,
            logger: debugLog,
          });
          if (IS_MAC) {
            domInputFallbackRef.current = attachTerminalDomInputFallback({
              textarea,
              logger: debugLog,
              nextTraceId: () => ++inputTraceSeqRef.current,
              onFallbackData: (data, traceId) => {
                const sessionId = currentSessionIdRef.current;
                debugLog("input.dom-fallback.write", {
                  traceId,
                  data: summarizeTerminalInputData(data),
                  disconnected: isDisconnectedRef.current,
                  hasSession: Boolean(sessionId),
                });
                if (isDisconnectedRef.current) return;
                if (sessionId) {
                  void terminalService.write(sessionId, data, { traceId });
                }
              },
            });
          }
          imeGuardRef.current = attachTerminalImeGuard({
            textarea,
            terminal: term,
            enabled: isLinuxWebKitImeEnvironment(),
            logger: debugLog,
          });
        }
        nativeMenuCleanupRef.current = () => {
          while (cleanupNativeMenuBlockers.length > 0) {
            cleanupNativeMenuBlockers.pop()?.();
          }
        };

        if (isTauriRuntime()) {
          try {
            void getCurrentWebview()
              .onDragDropEvent((event) => {
                const payload = event.payload;
                if (payload.type !== "drop") return;

                const host = terminalRef.current;
                if (!host || !isDropInsideTerminalHost(host, payload.position)) return;

                const text = formatTerminalFilePaths(payload.paths);
                if (!text) return;

                debugLog("drag-drop.paste", {
                  pathCount: payload.paths.length,
                  textLength: text.length,
                });
                pasteTextIntoTerminal(text, "file-drop");
              })
              .then((unlisten) => {
                if (!isMounted) {
                  unlisten();
                  return;
                }
                dragDropUnlistenRef.current = unlisten;
              })
              .catch((error) => {
                debugLog("drag-drop.listener.failed", {
                  error: getErrorMessage(error),
                });
              });
          } catch (error) {
            debugLog("drag-drop.listener.failed", {
              error: getErrorMessage(error),
            });
          }
        }

        // Intercept paste so file clipboard data can be resolved through the Tauri backend.
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (!imeGuardRef.current?.handleKeyEvent(e)) {
            return false;
          }

          if (isTerminalPasteShortcut(e, IS_MAC)) {
            e.preventDefault();
            e.stopPropagation();
            pasteTerminalPayload(null);
            return false;
          }

          if (isTerminalCopyShortcut(e, IS_MAC)) {
            // Copy the selection; without one Ctrl+C must stay SIGINT.
            const selection = term.getSelection();
            if (selection) {
              e.preventDefault();
              void copyTerminalSelection(selection)
                .then(() => {
                  term.clearSelection();
                  imeGuardRef.current?.clearNativeEditState("copy-selection");
                  term.focus();
                })
                .catch((error) => {
                  const message = getErrorMessage(error);
                  debugLog("clipboard.copy.failed", { error: message });
                  toast.error(`Copy failed: ${message}`);
                });
              return false;
            }
            // No selection: plain Ctrl/Cmd+C goes to the terminal (SIGINT);
            // Ctrl+Shift+C falls through to the global shortcut layer.
            if (!e.shiftKey) return true;
          }
          return shouldTerminalHandleKey(e);
        });

        // Fit once after the initial layout pass. Inactive/hidden tabs keep a
        // pending layout and flush it when they become visible.
        layoutSchedulerRef.current?.schedule("initial.fit");

        // Forward terminal input, with Enter-to-reconnect handling for SSH disconnects.
        const onDataDisposable = term.onData((data) => {
          const traceId = ++inputTraceSeqRef.current;
          debugLog("input.xterm.onData", {
            traceId,
            data: summarizeTerminalInputData(data),
            disconnected: isDisconnectedRef.current,
            hasSession: Boolean(currentSessionIdRef.current),
            focusReportMode: focusReportModeRef.current,
          });
          domInputFallbackRef.current?.recordXtermData(data);
          inputTraceRef.current?.onData(data);
          if (isXtermFocusReportInput(data) && !focusReportModeRef.current) {
            debugLog("input.xterm.drop.focus-report", {
              traceId,
              data: summarizeTerminalInputData(data),
              reason: "focus-report-mode-disabled",
            });
            return;
          }
          // Only Enter should trigger reconnect while disconnected.
          if (isDisconnectedRef.current) {
            if (!isReconnectingRef.current && (data === "\r" || data === "\n")) {
              doReconnect();
            }
            return;
          }
          const sessionId = currentSessionIdRef.current;
          if (sessionId) {
            void terminalService.write(sessionId, data, { traceId });
          } else {
            debugLog("input.xterm.drop.no-session", {
              traceId,
              data: summarizeTerminalInputData(data),
            });
          }
        });
        onDataDisposableRef.current = onDataDisposable;

        // Keep pane dragging responsive without fitting on every pointer move.
        const MIN_CONTAINER_CHANGE = 5;
        const DRAG_CONTAINER_CHANGE = 20;
        const DRAG_FIT_INTERVAL_MS = 80;
        const observer = new ResizeObserver((entries) => {
          if (!isMounted) return;
          const entry = entries[0];
          if (!entry) return;

          const { width, height } = entry.contentRect;
          if (isDragging()) {
            const now = performance.now();
            if (now - lastDragFitAtRef.current < DRAG_FIT_INTERVAL_MS) return;
            lastDragFitAtRef.current = now;
            layoutSchedulerRef.current?.flush("resize-observer.drag.fit", {
              containerSize: { width, height },
              minContainerDelta: DRAG_CONTAINER_CHANGE,
            });
            return;
          }

          layoutSchedulerRef.current?.schedule("resize-observer.fit", {
            delayMs: 150,
            containerSize: { width, height },
            minContainerDelta: MIN_CONTAINER_CHANGE,
          });
        });
        observer.observe(terminalRef.current);

        // Convert wheel events into arrow keys for non-agent TUI apps while the
        // alternate buffer is active. Agent CLIs keep output in the normal
        // buffer so the wheel scrolls history instead of selecting old prompts.
        const wheelHandler = (e: WheelEvent) => {
          const bufferType = term.buffer.active.type;
          const decision = keepCliOutputInNormalBuffer
            ? "agent-normal-scroll"
            : bufferType === "alternate"
              ? "alternate-handle"
              : "normal-bypass";
          if (lastWheelDecisionRef.current !== decision) {
            lastWheelDecisionRef.current = decision;
            debugLog("wheel.mode", {
              bufferType,
              decision,
              deltaMode: e.deltaMode,
            });
          }
          if (keepCliOutputInNormalBuffer) return;
          if (bufferType !== 'alternate') return;
          e.preventDefault();
          e.stopPropagation();
          const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 40));
          const arrow = e.deltaY < 0 ? '\x1b[A' : '\x1b[B';
          if (currentSessionIdRef.current) {
            terminalService.write(currentSessionIdRef.current, arrow.repeat(lines), { source: "system" });
          }
        };
        term.element?.addEventListener('wheel', wheelHandler, { passive: false });
        wheelHandlerRef.current = wheelHandler;

        resizeObserverRef.current = observer;
        syncTrackedBufferType("xterm.initialized");

        // Remember whether this terminal is backed by SSH for exit handling.
        isSshRef.current = !!props.ssh;

        // Create a new backend session or attach to an existing one.
        if (props.projectPath) {
          try {
            await ensureListeners();

            const liveSavedSessionId = props.sessionId
              ? null
              : await findLiveSavedSessionId(props.restoring ? props.savedSessionId : undefined);

            // Replay persisted output before deciding whether to create a live PTY.
            if (props.restoring && props.savedSessionId && !liveSavedSessionId) {
              try {
                const lines = await sessionRestoreService.loadOutput(props.savedSessionId);
                if (lines && lines.length > 0) {
                  debugLog("session.restore.replay", {
                    savedSessionId: props.savedSessionId,
                    lineCount: lines.length,
                  });
                  term.writeln("\x1b[90m--- Session restored ---\x1b[0m");
                  for (const line of lines) {
                    term.writeln(line);
                  }
                  term.writeln("");
                }
              } catch (err) {
                console.warn("[TerminalView] Failed to load restored output:", err);
              }

              // Restored tabs should start their live PTY on first app restore even when the
              // tab is hidden, otherwise background tabs can remain stuck on the restore overlay.
            }

            let sessionId: string;
            let effectiveResumeId = pickCreateSessionResumeId(props);
            const attachSessionId = props.sessionId ?? liveSavedSessionId;

            if (attachSessionId) {
              debugLog("session.attach-existing", {
                attachSessionId,
                source: props.sessionId ? "prop-session-id" : "live-saved-session",
                note: "reusing existing PTY session with replay snapshot when available",
              });
              console.info(`[TerminalView] Reconnecting to existing session: ${attachSessionId}`);
              sessionId = attachSessionId;
              try {
                await replayAttachedSession({
                  term,
                  sessionId,
                  getReplaySnapshot: (attachSessionId) => terminalService.getReplaySnapshot(attachSessionId),
                  writeData: (data) => {
                    const renderedData = renderTerminalData(data);
                    return renderedData ? writeTerminalData(renderedData) : Promise.resolve();
                  },
                  syncTrackedBufferType,
                  debugLog,
                });
              } catch (error) {
                debugLog("session.attach-existing.replay.fail", {
                  attachSessionId,
                  error: getErrorMessage(error),
                });
              }
            } else {
              if (props.layoutActive === false) {
                deferredRestoreRef.current = true;
                props.onRestoreLaunchState?.(props.restoring ? "queued" : "idle");
                debugLog("session.create.deferred-layout-hidden", {
                  restoring: props.restoring ?? false,
                });
                logRestoreEvent("init.deferred-layout-hidden");
                return;
              }

              // Init effect owns this terminal's restore (current/active layout); mark it
              // so the activation fallback below never double-launches the same tab.
              restoreLaunchStartedRef.current = true;

              // Create a brand-new backend session. Resume id comes only from the
              // tab/snapshot/props chain (never directory-level launch history).
              const cliTool = resolveCliTool(props.cliTool, props.launchClaude);
              const runtimeKind = resolveRuntimeKind(props.ssh, props.wsl);

              console.info(
                `[TerminalView] Creating new session: project=${props.projectPath}, launchClaude=${props.launchClaude ?? false}, resumeId=${effectiveResumeId ?? "none"}`
              );
              const backfillStartTime = new Date().toISOString();
              debugLog("session.create.begin", {
                resumeId: effectiveResumeId ?? null,
              });
              const launchSession = () => terminalService.createSession({
                launchId: props.projectId,
                projectPath: props.projectPath,
                cols: term.cols,
                rows: term.rows,
                workspaceName: props.workspaceName,
                providerId: props.providerId,
                providerSelection: props.providerSelection,
                launchProfileId: props.launchProfileId,
                workspacePath: props.workspacePath,
                workspaceSnapshotId: props.workspaceSnapshotId,
                launchClaude: props.launchClaude,
                cliTool: props.cliTool,
                resumeId: effectiveResumeId,
                skipMcp: props.skipMcp,
                appendSystemPrompt: props.appendSystemPrompt,
                // restore 路径不重放 initialPrompt（原会话已消费过）
                initialPrompt: props.restoring ? undefined : props.initialPrompt,
                yoloMode: props.yoloMode,
                adapterOptions: props.adapterOptions,
                ssh: props.ssh,
                wsl: props.wsl,
              });
              sessionId = props.restoring
                ? await terminalRestoreLaunchQueue.run(launchSession, {
                    isCancelled: () => !isMounted,
                    onState: props.onRestoreLaunchState,
                  })
                : await launchSession();
              props.onRestoreLaunchState?.("idle");
              debugLog("session.create.end", {
                createdSessionId: sessionId,
              });
              console.info(`[TerminalView] Session created: ${sessionId}`);
              if (!effectiveResumeId) {
                if (cliTool !== "none") {
                  historyService.startLaunchHistoryBackfill(
                    props.projectId,
                    sessionId,
                    cliTool,
                    runtimeKind,
                    props.wsl?.distro,
                    props.wsl?.remotePath ?? props.projectPath,
                    runtimeKind === "wsl" ? undefined : props.workspacePath,
                    backfillStartTime,
                  ).catch(console.error);
                }
              }
            }

            if (!isMounted) {
              if (!attachSessionId) {
                console.warn(`[TerminalView] Component unmounted during init, killing session: ${sessionId}`);
                terminalService.killSession(sessionId).catch(console.error);
              }
              return;
            }

            currentSessionIdRef.current = sessionId;
            debugLog("session.current.updated", {
              currentSessionId: sessionId,
            });

            if (!props.sessionId) {
              onSessionCreatedRef.current(sessionId);
              // Persist the corrected resume id back into the tab state.
              if (effectiveResumeId && effectiveResumeId !== props.resumeId) {
                usePanesStore.getState().updateTabAgentResumeId(sessionId, effectiveResumeId);
              }
              // initialPrompt 已随本次 createSession 消费，清除防 restore/reattach 重放
              if (props.initialPrompt && props.tabId) {
                usePanesStore.getState().clearTabInitialPrompt(props.tabId);
              }
            }

            // Clear restore metadata once the live session is ready.
            if (props.restoring && props.paneId && props.tabId) {
              usePanesStore.getState().clearRestoring(props.paneId ?? "", props.tabId, props.paneId);
              if (props.savedSessionId) {
                sessionRestoreService.clearOutput(props.savedSessionId).catch(console.error);
              }
            }

            // Register output and exit handlers.
            await bindSessionCallbacks(sessionId);
            if (!isMounted) {
              unbindSessionCallbacks();
              return;
            }

            // Keep PTY size aligned when attaching to an existing session.
            if (attachSessionId) {
              terminalService.resize({ sessionId, cols: term.cols, rows: term.rows });
            }
          } catch (error) {
            if (!isMounted) return;
            if (isRestoreLaunchCancelled(error)) {
              deferredRestoreRef.current = true;
              restoreLaunchStartedRef.current = false;
              props.onRestoreLaunchState?.("idle");
              return;
            }
            if (props.restoring) {
              props.onRestoreLaunchState?.("failed");
            }
            onLaunchErrorRef.current?.(toTerminalLaunchError(error));
            console.error(
              `[TerminalView] FAILED to init session: project=${props.projectPath}, launchClaude=${props.launchClaude ?? false}, error=`,
              error
            );
            const errorMsg = getErrorMessage(error);
            const formattedInitError = formatTerminalInitError(errorMsg);
            if (formattedInitError) {
              for (const line of formattedInitError) {
                term.writeln(line);
              }
              return;
            }
            const cliNotFoundMatch = errorMsg.match(/(\w+) CLI not found/);
            if (cliNotFoundMatch) {
              const toolName = cliNotFoundMatch[1];
              const installHint = getCliInstallHint(toolName);
              console.error(`[TerminalView] ${toolName} CLI not found in PATH`);
              term.writeln(
                `\x1b[31m${toolName} CLI is not installed or not in PATH.\x1b[0m`
              );
              term.writeln(
                `\x1b[33mPlease install the ${toolName} CLI and make sure it's available in your PATH.\x1b[0m`
              );
              if (installHint) {
                term.writeln(`\x1b[33m${installHint}\x1b[0m`);
              }
            } else {
              term.writeln(
                `\x1b[31mFailed to initialize terminal session: ${errorMsg}\x1b[0m`
              );
            }
          }
        }
      };

      init();

      return () => {
        isMounted = false;
        isUnmountedRef.current = true;
        cleanup();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const term = terminalInstanceRef.current;
      if (!term) return;

      term.options.theme = xtermTheme;
      applyTerminalElementTheme(term, xtermTheme);
      layoutSchedulerRef.current?.schedule("theme.change");
    }, [xtermTheme]);

    useEffect(() => {
      const term = terminalInstanceRef.current;
      if (!term) return;

      const fontSignature = `${terminalFontSize}|${terminalFontFamily}`;
      const fontChanged =
        lastAppearanceFontRef.current !== null &&
        lastAppearanceFontRef.current !== fontSignature;
      lastAppearanceFontRef.current = fontSignature;

      term.options.fontSize = terminalFontSize;
      term.options.fontFamily = terminalFontFamily;
      term.options.cursorStyle = terminalCursorStyle;
      term.options.cursorBlink = terminalCursorBlink;

      if (fontChanged) {
        // WebGL caches glyphs in a texture atlas keyed by the previous font; if
        // it is not cleared the new font renders from stale (blurry/garbled)
        // glyphs. `document.fonts.ready` alone is not enough here: canvas
        // measurement does not trigger @font-face lazy-loading, so a
        // not-yet-requested family leaves `ready` already resolved and the
        // atlas rebuilds from the fallback font. Explicitly request the
        // family first (same path as terminal creation).
        void waitForTerminalFont(terminalFontSize, terminalFontFamily)
          .then(() => {
            if (terminalInstanceRef.current !== term) return;
            rendererControllerRef.current?.clearTextureAtlas("settings.font-change");
            layoutSchedulerRef.current?.schedule("settings.font-change", { force: true });
          })
          .catch(() => {
            // Font readiness is best-effort; the immediate refit below still runs.
          });
      }
      layoutSchedulerRef.current?.schedule("settings.terminal-appearance", { force: true });
    }, [
      terminalCursorBlink,
      terminalCursorStyle,
      terminalFontFamily,
      terminalFontSize,
    ]);

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

      lastWebglHeartbeatAtRef.current = Date.now();
      // 普通 resize/focus/visible **不再 clearTextureAtlas**：atlas 是跨同配置终端共享的，
      // 清一次会让其它共享 pane 残留错位（大片黑 + 碎片）。这些事件只做本 pane 的 fit/repaint；
      // 真正需要重建 atlas 的只有 DPR 变化（字形按新 DPR 重光栅）和休眠恢复（heartbeat resume-gap）。
      // atlas 结构变化时的跨 pane 同步已由 controller 的 notifyAtlasStructureChanged 负责。
      const handleWindowResize = () => {
        layoutSchedulerRef.current?.schedule("window.resize");
        rendererControllerRef.current?.repaint("window.resize");
      };
      const handleWindowFocus = () => {
        if (window.devicePixelRatio !== lastDevicePixelRatioRef.current) {
          scheduleWebglRecovery("window.focus.dpr-change");
          return;
        }
        rendererControllerRef.current?.repaint("window.focus");
      };
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          rendererControllerRef.current?.repaint("document.visible");
        }
      };

      window.addEventListener("resize", handleWindowResize);
      window.addEventListener("focus", handleWindowFocus);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      webglHeartbeatTimerRef.current = setInterval(() => {
        const now = Date.now();
        const elapsed = now - lastWebglHeartbeatAtRef.current;
        lastWebglHeartbeatAtRef.current = now;
        if (!shouldRunWebglRecovery()) return;

        if (elapsed > WEBGL_SLEEP_GAP_MS) {
          scheduleWebglRecovery("heartbeat.resume-gap", { forceRecreate: true });
          return;
        }

        rendererControllerRef.current?.repaint("webgl.heartbeat");
      }, WEBGL_HEARTBEAT_INTERVAL_MS);

      return () => {
        window.removeEventListener("resize", handleWindowResize);
        window.removeEventListener("focus", handleWindowFocus);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        if (webglHeartbeatTimerRef.current) {
          clearInterval(webglHeartbeatTimerRef.current);
          webglHeartbeatTimerRef.current = null;
        }
      };
    }, [scheduleWebglRecovery, shouldRunWebglRecovery]);

    // Refit on activation and create deferred PTYs for restored tabs.
    useEffect(() => {
      debugLog("active.effect", {
        deferredRestore: deferredRestoreRef.current,
        trackedBuffer: trackedBufferTypeRef.current,
      });

      let activationCancelled = false;

      const scheduleRefit = (onReady?: (term: Terminal) => void) => {
        layoutSchedulerRef.current?.schedule("active.refit", {
          focusIfSafe: props.isActive,
          allowInactive: Boolean(onReady),
          onAfterLayout: (term) => {
            if (activationCancelled) return;
            onReady?.(term);
          },
        });
      };

      // Create the deferred PTY once the layout is active. This covers terminals that
      // were mounted while their layout was hidden (non-current layouts), whose restore
      // is intentionally deferred until the layout is switched to. `everHiddenRef` is a
      // robust hand-off signal (set purely from layoutActive) so this fires even if the
      // init effect did not reach its defer branch; `restoreLaunchStartedRef` + the live
      // session check prevent double-launching a tab the init effect already owns.
      const needsDeferredRestore =
        (props.layoutActive ?? true) &&
        !currentSessionIdRef.current &&
        !restoreLaunchStartedRef.current &&
        (deferredRestoreRef.current || (everHiddenRef.current && props.restoring === true));
      if (!currentSessionIdRef.current && (everHiddenRef.current || deferredRestoreRef.current || props.restoring)) {
        logRestoreEvent("activation.effect", { needsDeferredRestore });
      }
      if (needsDeferredRestore) {
        if (!props.projectPath) return;

        restoreLaunchStartedRef.current = true;
        scheduleRefit((term) => {
          if (isUnmountedRef.current) return;

          deferredRestoreRef.current = false;

          void (async () => {
            try {
              await ensureListeners();

              const cliTool = resolveCliTool(props.cliTool, props.launchClaude);
              const runtimeKind = resolveRuntimeKind(props.ssh, props.wsl);
              const effectiveResumeId = pickCreateSessionResumeId(props);

              if (isUnmountedRef.current) return;

              const liveSavedSessionId = await findLiveSavedSessionId(props.savedSessionId);
              if (liveSavedSessionId) {
                currentSessionIdRef.current = liveSavedSessionId;
                debugLog("session.deferred-restore.attach-existing", {
                  attachSessionId: liveSavedSessionId,
                });
                props.onRestoreLaunchState?.("idle");
                onSessionCreatedRef.current(liveSavedSessionId);
                await replayAttachedSession({
                  term,
                  sessionId: liveSavedSessionId,
                  getReplaySnapshot: (attachSessionId) => terminalService.getReplaySnapshot(attachSessionId),
                  writeData: (data) => {
                    const renderedData = renderTerminalData(data);
                    return renderedData ? writeTerminalData(renderedData) : Promise.resolve();
                  },
                  syncTrackedBufferType,
                  debugLog,
                });
                if (props.paneId && props.tabId) {
                  usePanesStore.getState().clearRestoring(props.paneId ?? "", props.tabId, props.paneId);
                  sessionRestoreService.clearOutput(liveSavedSessionId).catch(console.error);
                }
                await bindSessionCallbacks(liveSavedSessionId);
                if (isUnmountedRef.current) {
                  unbindSessionCallbacks();
                }
                return;
              }

              debugLog("session.deferred-restore.begin", {
                resumeId: effectiveResumeId ?? null,
              });
              logRestoreEvent("activation.create.begin", { resumeId: effectiveResumeId ?? null });
              console.info(`[TerminalView] Deferred restore: creating PTY for ${props.projectPath}`);
              const backfillStartTime = new Date().toISOString();
              const launchSession = () => terminalService.createSession({
                launchId: props.projectId,
                projectPath: props.projectPath,
                cols: term.cols,
                rows: term.rows,
                workspaceName: props.workspaceName,
                providerId: props.providerId,
                providerSelection: props.providerSelection,
                launchProfileId: props.launchProfileId,
                workspacePath: props.workspacePath,
                workspaceSnapshotId: props.workspaceSnapshotId,
                launchClaude: props.launchClaude,
                cliTool: props.cliTool,
                resumeId: effectiveResumeId,
                skipMcp: props.skipMcp,
                appendSystemPrompt: props.appendSystemPrompt,
                // deferred restore 是恢复路径：不携带 initialPrompt（防重放）
                yoloMode: props.yoloMode,
                adapterOptions: props.adapterOptions,
                ssh: props.ssh,
                wsl: props.wsl,
              });
              const sessionId = await terminalRestoreLaunchQueue.run(launchSession, {
                isCancelled: () => isUnmountedRef.current || activationCancelled || !layoutActiveRef.current,
                onState: props.onRestoreLaunchState,
              });
              props.onRestoreLaunchState?.("idle");

              if (isUnmountedRef.current) {
                terminalService.killSession(sessionId).catch(console.error);
                return;
              }

              currentSessionIdRef.current = sessionId;
              debugLog("session.deferred-restore.end", {
                createdSessionId: sessionId,
              });
              logRestoreEvent("activation.create.end", { createdSessionId: sessionId });
              onSessionCreatedRef.current(sessionId);
              if (!effectiveResumeId) {
                if (cliTool !== "none") {
                  historyService.startLaunchHistoryBackfill(
                    props.projectId,
                    sessionId,
                    cliTool,
                    runtimeKind,
                    props.wsl?.distro,
                    props.wsl?.remotePath ?? props.projectPath,
                    runtimeKind === "wsl" ? undefined : props.workspacePath,
                    backfillStartTime,
                  ).catch(console.error);
                }
              }

              // Clear restoring state once the deferred session is live.
              if (props.paneId && props.tabId) {
                usePanesStore.getState().clearRestoring(props.paneId ?? "", props.tabId, props.paneId);
                if (props.savedSessionId) {
                  sessionRestoreService.clearOutput(props.savedSessionId).catch(console.error);
                }
              }
              await bindSessionCallbacks(sessionId);
              if (isUnmountedRef.current) {
                unbindSessionCallbacks();
              }
            } catch (err) {
              if (isUnmountedRef.current) return;
              if (isRestoreLaunchCancelled(err)) {
                deferredRestoreRef.current = true;
                restoreLaunchStartedRef.current = false;
                logRestoreEvent("activation.create.cancelled");
                props.onRestoreLaunchState?.("idle");
                return;
              }
              restoreLaunchStartedRef.current = false;
              props.onRestoreLaunchState?.("failed");
              onLaunchErrorRef.current?.(toTerminalLaunchError(err));
              logRestoreEvent("activation.create.failed", { error: getErrorMessage(err) });
              console.error("[TerminalView] Deferred restore failed:", err);
              term.writeln(`\x1b[31m--- Failed to restore session: ${getErrorMessage(err)} ---\x1b[0m`);
            }
          })();
        });

        return () => {
          activationCancelled = true;
          layoutSchedulerRef.current?.cancel();
        };
      }

      if (props.isActive && fitAddonRef.current) {
        scheduleRefit();
        return () => {
          activationCancelled = true;
          layoutSchedulerRef.current?.cancel();
        };
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.isActive, props.isVisible, props.layoutActive]);

    /* ---------------- 终端区右键菜单动作 ---------------- */

    const getTerminalSelection = useCallback(
      () => terminalInstanceRef.current?.getSelection() ?? "",
      []
    );

    const handleMenuCopySelection = useCallback(() => {
      const term = terminalInstanceRef.current;
      const selection = term?.getSelection();
      if (!term || !selection) return;
      void copyTerminalSelection(selection)
        .then(() => {
          term.clearSelection();
          term.focus();
        })
        .catch((error) => {
          const message = getErrorMessage(error);
          debugLog("clipboard.copy.failed", { error: message });
          toast.error(t("terminalCopyFailed", { error: message }));
        });
    }, [debugLog, t]);

    const handleMenuSelectAll = useCallback(() => {
      const term = terminalInstanceRef.current;
      if (!term) return;
      term.focus();
      term.selectAll();
    }, []);

    const handleMenuPaste = useCallback(() => {
      pasteRequestRef.current?.();
    }, []);

    const getMenuSessionId = useCallback(
      () => currentSessionIdRef.current ?? props.sessionId ?? null,
      [props.sessionId]
    );

    const handleMenuRefreshTerminal = useCallback(() => {
      const term = terminalInstanceRef.current;
      if (!term) return;
      // 花屏/字形变形多是 WebGL 图集脏了；未铺满是 fit 没跟上容器。
      // 清图集 + 强制 refit（scheduler flush 会顺带 repaint）一次到位。
      rendererControllerRef.current?.clearTextureAtlas("context-menu.refresh");
      refitAndRepaintTerminal("context-menu.refresh", { focusIfSafe: true });
      repaintTerminal("context-menu.refresh");
    }, [refitAndRepaintTerminal, repaintTerminal]);

    const handleMenuCopySessionId = useCallback(() => {
      const sessionId = currentSessionIdRef.current ?? props.sessionId;
      if (!sessionId) return;
      void copyTerminalSelection(sessionId)
        .then(() => toast.success(t("terminalSessionIdCopied", { id: sessionId })))
        .catch((error) => {
          toast.error(t("terminalCopyFailed", { error: getErrorMessage(error) }));
        });
    }, [props.sessionId, t]);

    const handleMenuClearBuffer = useCallback(() => {
      const term = terminalInstanceRef.current;
      if (!term) return;
      term.clear();
      term.focus();
    }, []);

    const handleMenuCopyBuffer = useCallback(() => {
      const term = terminalInstanceRef.current;
      if (!term) return;
      const text = serializeTerminalBuffer(term);
      if (!text) return;
      void copyTerminalSelection(text).catch((error) => {
        const message = getErrorMessage(error);
        debugLog("clipboard.copy.failed", { error: message });
        toast.error(t("terminalCopyFailed", { error: message }));
      });
    }, [debugLog, t]);

    const handleMenuExportBuffer = useCallback(async () => {
      const term = terminalInstanceRef.current;
      if (!term) return;
      const text = serializeTerminalBuffer(term);
      const fileName = buildTerminalExportFileName(props.projectPath, new Date());
      try {
        if (isTauriRuntime()) {
          const path = await saveFileDialog({
            defaultPath: fileName,
            filters: [{ name: "Text", extensions: ["txt"] }],
          });
          if (!path) return;
          await filesystemService.writeFile(path, text);
          toast.success(t("terminalExportSuccess", { path }));
        } else {
          // 浏览器运行时无 fs 命令，退化为下载。
          const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = fileName;
          anchor.click();
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        toast.error(t("terminalExportFailed", { error: getErrorMessage(error) }));
      }
    }, [props.projectPath, t]);

    const handleMenuOpenProjectDir = useCallback(() => {
      if (!props.projectPath) return;
      void providerService.openPathInExplorer(props.projectPath).catch((error) => {
        toast.error(t("terminalOpenDirFailed", { error: getErrorMessage(error) }));
      });
    }, [props.projectPath, t]);

    return (
      <div
        className="h-full w-full overflow-hidden flex flex-col"
        style={{
          "--cc-terminal-bg": terminalTheme.background,
          "--cc-terminal-fg": terminalTheme.foreground,
          background: terminalTheme.background,
          color: terminalTheme.foreground,
          paddingTop: 'var(--notch-bar-height, 0px)',
        } as CSSProperties}
      >
        <TerminalContextMenu
          enabled={!IS_MAC}
          getSelection={getTerminalSelection}
          getSessionId={getMenuSessionId}
          onCopySelection={handleMenuCopySelection}
          onSelectAll={handleMenuSelectAll}
          onPaste={handleMenuPaste}
          onRefreshTerminal={handleMenuRefreshTerminal}
          onCopySessionId={handleMenuCopySessionId}
          onClearBuffer={handleMenuClearBuffer}
          onCopyBuffer={handleMenuCopyBuffer}
          onExportBuffer={handleMenuExportBuffer}
          onOpenProjectDir={props.projectPath ? handleMenuOpenProjectDir : undefined}
        >
          <div
            ref={terminalRef}
            className="cc-terminal-host flex-1 overflow-hidden [&_.xterm]:h-full"
            onContextMenu={(event) => {
              if (!IS_MAC) return;
              event.preventDefault();
              event.stopPropagation();
              terminalInstanceRef.current?.focus();
            }}
          />
        </TerminalContextMenu>
      </div>
    );
  }
);

export default TerminalView;
