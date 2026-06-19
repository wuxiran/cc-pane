import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle, type CSSProperties } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { writeText as tauriWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { terminalService, historyService, sessionRestoreService } from "@/services";
import { ensureListeners } from "@/services/terminalService";
import { getErrorMessage } from "@/utils";
import { pickCreateSessionResumeId } from "./terminalResume";
import { devDebugLog } from "@/utils/devLogger";
import {
  TERMINAL_LAYOUT_CHANGED_EVENT,
  shouldTerminalHandleKey,
  useShortcutsStore,
  useSettingsStore,
  usePanesStore,
  useThemeStore,
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
  detectAlternateBufferTransitions,
  shouldKeepCliOutputInNormalBuffer,
  stripAlternateBufferSequences,
} from "./terminalBufferMode";
import { formatTerminalFilePaths, resolveTerminalPastePayload } from "./terminalClipboard";
import { isDropInsideTerminalHost } from "./terminalDrop";
import { attachTerminalInputTrace } from "./terminalInputTrace";
import { attachTerminalImeGuard, isLinuxWebKitImeEnvironment } from "./terminalImeGuard";
import { isTerminalPasteShortcut } from "./terminalKeyboard";
import { createTerminalWriteFlowControl } from "./terminalWriteFlowControl";
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
import { getTerminalTheme, type TerminalThemePalette } from "./terminalTheme";
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
const DEFAULT_TERMINAL_FONT_FAMILY = '"Maple Mono NF CN", "Maple Mono", "Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, "Sarasa Mono SC", "Microsoft YaHei UI", "PingFang SC", monospace';
const DEFAULT_TERMINAL_SCROLLBACK = 20_000;
const WEBGL_HEARTBEAT_INTERVAL_MS = 30_000;
const WEBGL_SLEEP_GAP_MS = 75_000;
const WEBGL_RECOVERY_PROMOTION_WINDOW_MS = 12_000;

type TerminalCursorStyle = "block" | "underline" | "bar";

function normalizeTerminalFontSize(value?: number | null): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE;
  const rounded = Math.round(value as number);
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, rounded));
}

function normalizeTerminalFontFamily(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_TERMINAL_FONT_FAMILY;
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

async function findLiveSavedSessionId(savedSessionId?: string): Promise<string | null> {
  if (!savedSessionId) return null;
  const statuses = await terminalService.getAllStatus();
  return statuses.some((status) => (
    status.sessionId === savedSessionId && status.status !== "exited"
  ))
    ? savedSessionId
    : null;
}

function writeTerminalReply(
  sessionId: string | null,
  response: string,
  onError: (error: unknown) => void,
) {
  if (!sessionId) return;
  void terminalService.write(sessionId, response).catch(onError);
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
    const isDark = useThemeStore((s) => s.isDark);
    const terminalThemeMode = useSettingsStore((s): TerminalThemeMode => s.settings?.terminal.themeMode ?? "followApp");
    const terminalFontSize = useSettingsStore((s) => normalizeTerminalFontSize(s.settings?.terminal.fontSize));
    const terminalFontFamily = useSettingsStore((s) => normalizeTerminalFontFamily(s.settings?.terminal.fontFamily));
    const terminalCursorStyle = useSettingsStore((s) => normalizeTerminalCursorStyle(s.settings?.terminal.cursorStyle));
    const terminalCursorBlink = useSettingsStore((s) => s.settings?.terminal.cursorBlink ?? false);
    const terminalTheme = getTerminalTheme(isDark, terminalThemeMode);
    const terminalRef = useRef<HTMLDivElement>(null);
    const terminalInstanceRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const rendererControllerRef = useRef<TerminalRendererController | null>(null);
    const layoutSchedulerRef = useRef<TerminalLayoutScheduler | null>(null);
    const onDataDisposableRef = useRef<IDisposable | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const currentSessionIdRef = useRef<string | null>(null);
    const wheelHandlerRef = useRef<((e: WheelEvent) => void) | null>(null);
    const pasteHandlerRef = useRef<((e: ClipboardEvent) => void) | null>(null);
    const dragDropUnlistenRef = useRef<(() => void) | null>(null);
    const inputTraceRef = useRef<ReturnType<typeof attachTerminalInputTrace> | null>(null);
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

    const onSessionCreatedRef = useRef(props.onSessionCreated);
    const onSessionExitedRef = useRef(props.onSessionExited);
    const onReconnectRef = useRef(props.onReconnect);
    const debugInstanceIdRef = useRef(`term-${Math.random().toString(36).slice(2, 8)}`);
    const trackedBufferTypeRef = useRef<"unknown" | "normal" | "alternate">("unknown");
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
    const renderTerminalData = useCallback((data: string) => {
      if (!keepCliOutputInNormalBuffer) return data;
      return stripAlternateBufferSequences(data);
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
      await flowControl.write(data, onWritten);
    }, []);

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
      onReconnectRef.current = props.onReconnect;
      isActiveRef.current = props.isActive;
      isVisibleRef.current = props.isVisible ?? props.isActive;
      layoutActiveRef.current = props.layoutActive ?? true;
    });

    useEffect(() => {
      const effectiveRendererMode = resolveRendererMode(terminalRendererMode);
      terminalRendererModeRef.current = effectiveRendererMode;
      rendererControllerRef.current?.configure(effectiveRendererMode);
      layoutSchedulerRef.current?.schedule("settings.renderer-mode");
    }, [resolveRendererMode, terminalRendererMode]);

    useEffect(() => {
      if (typeof window === "undefined") return;

      const handleLayoutChanged = (event: Event) => {
        const reason =
          event instanceof CustomEvent && typeof event.detail?.reason === "string"
            ? event.detail.reason
            : "layout";
        debugLog("layout-change.refit.flush", { reason });
        layoutSchedulerRef.current?.flush(`layout-change.${reason}`, { force: true });
      };

      window.addEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, handleLayoutChanged);
      return () => {
        window.removeEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, handleLayoutChanged);
      };
    }, [debugLog]);

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
        terminalService.detachOutput(currentSessionIdRef.current);
        terminalService.detachExit(currentSessionIdRef.current);
        currentSessionIdRef.current = null;
      }
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
    }, [debugLog]);

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
      await terminalService.registerOutput(sessionId, (data) => {
        const term = terminalInstanceRef.current;
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
      await terminalService.registerExit(sessionId, (exitCode) => {
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
        if (currentSessionIdRef.current) {
          terminalService.detachOutput(currentSessionIdRef.current);
          terminalService.detachExit(currentSessionIdRef.current);
        }

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
    }, [bindSessionCallbacks]);

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

        const termSettings = useSettingsStore.getState().settings?.terminal;
        const scrollback = termSettings?.scrollback ?? DEFAULT_TERMINAL_SCROLLBACK;
        const fontSize = normalizeTerminalFontSize(termSettings?.fontSize);
        const fontFamily = normalizeTerminalFontFamily(termSettings?.fontFamily);
        const cursorStyle = normalizeTerminalCursorStyle(termSettings?.cursorStyle);
        const cursorBlink = termSettings?.cursorBlink ?? false;
        const term = new Terminal({
          allowProposedApi: true,
          cursorBlink,
          cursorStyle,
          fastScrollSensitivity: 5,
          fontSize,
          smoothScrollDuration: 0,
          scrollback,
          fontFamily,
          ...(navigator.platform.startsWith('Win') && buildNumber && buildNumber > 0 && {
            windowsPty: {
              backend: 'conpty' as const,
              buildNumber,
            },
          }),
          theme: terminalTheme,
        });

        const fit = new FitAddon();
        term.loadAddon(fit);

        term.open(terminalRef.current);
        applyTerminalElementTheme(term, terminalTheme);
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
          void terminalService.write(sessionId, response).catch((error) => {
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

        // Track terminal focus so global shortcuts can defer to xterm.
        const textarea = term.textarea;
        if (textarea) {
          const setFocused = useShortcutsStore.getState().setTerminalFocused;
          textarea.addEventListener('focus', () => {
            setFocused(true);
            debugLog("textarea.focus", {});
          });
          textarea.addEventListener('blur', () => {
            setFocused(false);
            debugLog("textarea.blur", {});
          });

          const pasteHandler = (e: ClipboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            pasteTerminalPayload(e.clipboardData);
          };

          textarea.addEventListener('paste', pasteHandler, true);
          pasteHandlerRef.current = pasteHandler;
          inputTraceRef.current = attachTerminalInputTrace({
            textarea,
            isDev: TERMINAL_DEBUG,
            isMac: IS_MAC,
            logger: debugLog,
          });
          imeGuardRef.current = attachTerminalImeGuard({
            textarea,
            terminal: term,
            enabled: isLinuxWebKitImeEnvironment(),
            logger: debugLog,
          });
        }

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

          if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey) {
            // Copy the selection on Ctrl+C; otherwise let the terminal handle SIGINT.
            if (!e.shiftKey && (e.key === 'c' || e.key === 'C')) {
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
              return true;
            }
          }
          return shouldTerminalHandleKey(e);
        });

        // Fit once after the initial layout pass. Inactive/hidden tabs keep a
        // pending layout and flush it when they become visible.
        layoutSchedulerRef.current?.schedule("initial.fit");

        // Forward terminal input, with Enter-to-reconnect handling for SSH disconnects.
        const onDataDisposable = term.onData((data) => {
          inputTraceRef.current?.onData(data);
          // Only Enter should trigger reconnect while disconnected.
          if (isDisconnectedRef.current) {
            if (!isReconnectingRef.current && (data === "\r" || data === "\n")) {
              doReconnect();
            }
            return;
          }
          const sessionId = currentSessionIdRef.current;
          if (sessionId) {
            terminalService.write(sessionId, data);
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
            terminalService.write(currentSessionIdRef.current, arrow.repeat(lines));
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
                return;
              }

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
              terminalService.detachOutput(sessionId);
              terminalService.detachExit(sessionId);
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
              props.onRestoreLaunchState?.("idle");
              return;
            }
            if (props.restoring) {
              props.onRestoreLaunchState?.("failed");
            }
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
              console.error(`[TerminalView] ${toolName} CLI not found in PATH`);
              term.writeln(
                `\x1b[31m${toolName} CLI is not installed or not in PATH.\x1b[0m`
              );
              term.writeln(
                `\x1b[33mPlease install the ${toolName} CLI and make sure it's available in your PATH.\x1b[0m`
              );
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

      term.options.theme = terminalTheme;
      applyTerminalElementTheme(term, terminalTheme);
      layoutSchedulerRef.current?.schedule("theme.change");
    }, [terminalTheme]);

    useEffect(() => {
      const term = terminalInstanceRef.current;
      if (!term) return;

      term.options.fontSize = terminalFontSize;
      term.options.fontFamily = terminalFontFamily;
      term.options.cursorStyle = terminalCursorStyle;
      term.options.cursorBlink = terminalCursorBlink;
      layoutSchedulerRef.current?.schedule("settings.terminal-appearance", { force: true });
    }, [
      terminalCursorBlink,
      terminalCursorStyle,
      terminalFontFamily,
      terminalFontSize,
    ]);

    useEffect(() => {
      if (!IS_WINDOWS) return;

      lastWebglHeartbeatAtRef.current = Date.now();
      const handleWindowResize = () => {
        scheduleWebglRecovery("window.resize");
      };
      const handleWindowFocus = () => {
        if (window.devicePixelRatio !== lastDevicePixelRatioRef.current) {
          scheduleWebglRecovery("window.focus.dpr-change");
          return;
        }
        scheduleWebglRecovery("window.focus");
      };
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          scheduleWebglRecovery("document.visible");
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

      // Create the deferred PTY once the layout is active. It may be hidden in a
      // background tab within the same layout; those restoring tabs still launch.
      if ((props.layoutActive ?? true) && deferredRestoreRef.current) {
        if (!props.projectPath) return;

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
                  terminalService.detachOutput(liveSavedSessionId);
                  terminalService.detachExit(liveSavedSessionId);
                }
                return;
              }

              debugLog("session.deferred-restore.begin", {
                resumeId: effectiveResumeId ?? null,
              });
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
                terminalService.detachOutput(sessionId);
                terminalService.detachExit(sessionId);
              }
            } catch (err) {
              if (isUnmountedRef.current) return;
              if (isRestoreLaunchCancelled(err)) {
                deferredRestoreRef.current = true;
                props.onRestoreLaunchState?.("idle");
                return;
              }
              props.onRestoreLaunchState?.("failed");
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
        <div ref={terminalRef} className="cc-terminal-host flex-1 overflow-hidden [&_.xterm]:h-full" />
      </div>
    );
  }
);

export default TerminalView;
