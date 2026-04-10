import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { writeText as tauriWriteText, readText as tauriReadText } from "@tauri-apps/plugin-clipboard-manager";
import { terminalService, historyService, sessionRestoreService } from "@/services";
import { ensureListeners } from "@/services/terminalService";
import { getErrorMessage } from "@/utils";
import { devDebugLog } from "@/utils/devLogger";
import { shouldTerminalHandleKey, useShortcutsStore, useSettingsStore, usePanesStore } from "@/stores";
import { isDragging } from "@/stores/splitDragState";
import { replayAttachedSession } from "./terminalReplay";
import { formatTerminalInitError } from "./terminalInitError";
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

import type { CliTool, SshConnectionInfo, WslLaunchInfo } from "@/types";

const TERMINAL_DEBUG = import.meta.env.DEV;
const ALTERNATE_BUFFER_SEQUENCE = /\x1b\[\?(1049|1047|47)(h|l)/g;

interface AlternateBufferTransition {
  mode: string;
  action: "enter" | "exit";
}

function detectAlternateBufferTransitions(data: string): AlternateBufferTransition[] {
  const transitions: AlternateBufferTransition[] = [];
  for (const match of data.matchAll(new RegExp(ALTERNATE_BUFFER_SEQUENCE.source, "g"))) {
    transitions.push({
      mode: match[1],
      action: match[2] === "h" ? "enter" : "exit",
    });
  }
  return transitions;
}

function resolveCliTool(cliTool?: CliTool, launchClaude?: boolean): string {
  return cliTool ?? (launchClaude ? "claude" : "none");
}

interface TerminalViewProps {
  sessionId: string | null;
  projectPath: string;
  isActive: boolean;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
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
    const terminalRef = useRef<HTMLDivElement>(null);
    const terminalInstanceRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const webglAddonRef = useRef<WebglAddon | null>(null);
    const onDataDisposableRef = useRef<IDisposable | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const currentSessionIdRef = useRef<string | null>(null);
    const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const lastContainerSizeRef = useRef<{ width: number; height: number } | null>(null);
    const wheelHandlerRef = useRef<((e: WheelEvent) => void) | null>(null);

    // Track SSH reconnect state.
    const isDisconnectedRef = useRef(false);
    const isReconnectingRef = useRef(false);
    const isSshRef = useRef(!!props.ssh);
    const isUnmountedRef = useRef(false);
    // Delay PTY creation for inactive restored tabs until they become active.
    const deferredRestoreRef = useRef(false);

    const onSessionCreatedRef = useRef(props.onSessionCreated);
    const onSessionExitedRef = useRef(props.onSessionExited);
    const onReconnectRef = useRef(props.onReconnect);
    const debugInstanceIdRef = useRef(`term-${Math.random().toString(36).slice(2, 8)}`);
    const trackedBufferTypeRef = useRef<"unknown" | "normal" | "alternate">("unknown");
    const lastWheelDecisionRef = useRef<string | null>(null);

    const debugLog = useCallback((event: string, payload: Record<string, unknown> = {}) => {
      if (!TERMINAL_DEBUG) return;
      devDebugLog("terminal-debug", event, {
        instanceId: debugInstanceIdRef.current,
        paneId: props.paneId ?? null,
        tabId: props.tabId ?? null,
        projectPath: props.projectPath,
        propSessionId: props.sessionId ?? null,
        sessionId: currentSessionIdRef.current ?? props.sessionId ?? null,
        cliTool: resolveCliTool(props.cliTool, props.launchClaude),
        isActive: props.isActive,
        xtermBuffer: terminalInstanceRef.current?.buffer.active.type ?? null,
        ...payload,
      });
    }, [
      props.cliTool,
      props.isActive,
      props.launchClaude,
      props.paneId,
      props.projectPath,
      props.sessionId,
      props.tabId,
    ]);

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

    // Expose imperative helpers to parent panes.
    useImperativeHandle(ref, () => ({
      focus: () => terminalInstanceRef.current?.focus(),
      fit: () => fitAddonRef.current?.fit(),
    }));

    // Keep callback refs in sync with the latest props.
    useEffect(() => {
      onSessionCreatedRef.current = props.onSessionCreated;
      onSessionExitedRef.current = props.onSessionExited;
      onReconnectRef.current = props.onReconnect;
    });

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
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }

      // Remove the wheel handler before disposing xterm.
      if (wheelHandlerRef.current && terminalInstanceRef.current?.element) {
        terminalInstanceRef.current.element.removeEventListener('wheel', wheelHandlerRef.current);
        wheelHandlerRef.current = null;
      }

      // Dispose addons before the terminal instance.
      const webglToDispose = webglAddonRef.current;
      const fitToDispose = fitAddonRef.current;
      const termToDispose = terminalInstanceRef.current;
      terminalInstanceRef.current = null;
      webglAddonRef.current = null;
      fitAddonRef.current = null;
      lastContainerSizeRef.current = null;
      trackedBufferTypeRef.current = "unknown";
      lastWheelDecisionRef.current = null;

      if (webglToDispose) {
        try {
          webglToDispose.dispose();
        } catch {
          // Safe to ignore if the WebGL addon is already torn down.
        }
      }
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
        if (transitions.length > 0) {
          debugLog("output.alternate-sequence.received", {
            bindSessionId: sessionId,
            transitions,
            dataLength: data.length,
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

        term.write(data, () => {
          if (transitions.length > 0) {
            debugLog("output.alternate-sequence.applied", {
              bindSessionId: sessionId,
              transitions,
              bufferAfter: term.buffer.active.type,
            });
          }
          syncTrackedBufferType(
            transitions.length > 0 ? "output.alternate-sequence" : "output.write"
          );
        });
      });
      await terminalService.registerExit(sessionId, (exitCode) => {
        handleSessionExit(sessionId, exitCode);
      });
      debugLog("session.bind-callbacks.end", {
        bindSessionId: sessionId,
      });
    }, [debugLog, handleSessionExit, syncTrackedBufferType]);

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
        const scrollback = termSettings?.scrollback ?? 1000;
        const fontFamily = termSettings?.fontFamily || 'Consolas, "Courier New", "Microsoft YaHei Mono", "Noto Sans Mono CJK SC", "PingFang SC", monospace';

        const term = new Terminal({
          allowProposedApi: true,
          cursorBlink: true,
          fontSize: 14,
          scrollback,
          fontFamily,
          ...(navigator.platform.startsWith('Win') && buildNumber && buildNumber > 0 && {
            windowsPty: {
              backend: 'conpty' as const,
              buildNumber,
            },
          }),
          theme: {
            background: "#1a1a1a",
            foreground: "#f5f5f7",
            cursor: "#0a84ff",
            cursorAccent: "#1a1a1a",
            selectionBackground: "rgba(10, 132, 255, 0.3)",
            selectionForeground: "#f5f5f7",
            black: "#1a1a1a",
            red: "#ff453a",
            green: "#30d158",
            yellow: "#ffd60a",
            blue: "#0a84ff",
            magenta: "#bf5af2",
            cyan: "#64d2ff",
            white: "#f5f5f7",
            brightBlack: "#6e6e73",
            brightRed: "#ff6961",
            brightGreen: "#4ae08a",
            brightYellow: "#ffe620",
            brightBlue: "#409cff",
            brightMagenta: "#da8aff",
            brightCyan: "#70d7ff",
            brightWhite: "#ffffff",
          },
        });

        const fit = new FitAddon();
        term.loadAddon(fit);

        term.open(terminalRef.current);
        trackedBufferTypeRef.current = term.buffer.active.type;
        debugLog("xterm.ready", {
          scrollback,
          fontFamily,
          initialBuffer: term.buffer.active.type,
        });

        // Use Unicode 11 widths so CJK and emoji render correctly.
        const unicode11 = new Unicode11Addon();
        term.loadAddon(unicode11);
        term.unicode.activeVersion = "11";

        // Prefer WebGL when available and fall back to Canvas2D on failure.
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            console.warn("[TerminalView] WebGL context lost, falling back to Canvas2D");
            try { webgl.dispose(); } catch { /* ignore */ }
            webglAddonRef.current = null;
          });
          term.loadAddon(webgl);
          webglAddonRef.current = webgl;
        } catch {
          console.info("[TerminalView] WebGL not available, using Canvas2D renderer");
        }

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
        }

        // Intercept clipboard shortcuts while still allowing terminal keys through.
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey) {
            // Copy the selection on Ctrl+C; otherwise let the terminal handle SIGINT.
            if (!e.shiftKey && (e.key === 'c' || e.key === 'C')) {
              const selection = term.getSelection();
              if (selection) {
                e.preventDefault();
                // Prefer the Web API and fall back to the Tauri clipboard plugin.
                navigator.clipboard.writeText(selection)
                  .catch(() => tauriWriteText(selection).catch(() => {}));
                term.clearSelection();
                return false;
              }
              return true;
            }
            // Read the clipboard explicitly on Ctrl+V to avoid duplicate paste events.
            if (e.key === 'v' || e.key === 'V') {
              e.preventDefault();
              // Prefer the Web API and fall back to the Tauri clipboard plugin.
              navigator.clipboard.readText()
                .then((text) => { if (text) term.paste(text); })
                .catch(() => tauriReadText().then((text) => { if (text) term.paste(text); }).catch(() => {}));
              return false;
            }
          }
          return shouldTerminalHandleKey(e);
        });

        // Fit once after the initial layout pass.
        requestAnimationFrame(() => fit.fit());

        // Forward terminal input, with Enter-to-reconnect handling for SSH disconnects.
        const onDataDisposable = term.onData((data) => {
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

        // Debounce fit/resize work and ignore tiny layout jitter while dragging.
        // Small sub-pixel layout changes should not trigger a full terminal resize.
        // Pane drag handling will trigger a compensating resize after the drag completes.
        const MIN_CONTAINER_CHANGE = 5;
        const observer = new ResizeObserver((entries) => {
          if (!isMounted) return;
          if (isDragging()) return; // Skip resize work entirely while pane dragging is active.
          const entry = entries[0];
          if (!entry) return;

          const { width, height } = entry.contentRect;
          if (
            lastContainerSizeRef.current &&
            Math.abs(width - lastContainerSizeRef.current.width) < MIN_CONTAINER_CHANGE &&
            Math.abs(height - lastContainerSizeRef.current.height) < MIN_CONTAINER_CHANGE
          ) {
            return;
          }
          lastContainerSizeRef.current = { width, height };

          if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = setTimeout(() => {
            requestAnimationFrame(() => {
              if (!isMounted || !fitAddonRef.current || !terminalInstanceRef.current) return;
              fitAddonRef.current.fit();
              const { cols, rows } = terminalInstanceRef.current;
              if (lastSizeRef.current?.cols === cols && lastSizeRef.current?.rows === rows) return;
              lastSizeRef.current = { cols, rows };
              if (currentSessionIdRef.current) {
                terminalService.resize({
                  sessionId: currentSessionIdRef.current,
                  cols,
                  rows,
                });
              }
            });
          }, 150);
        });
        observer.observe(terminalRef.current);

        // Convert wheel events into arrow keys while the alternate buffer is active.
        const wheelHandler = (e: WheelEvent) => {
          const bufferType = term.buffer.active.type;
          const decision = bufferType === "alternate" ? "alternate-handle" : "normal-bypass";
          if (lastWheelDecisionRef.current !== decision) {
            lastWheelDecisionRef.current = decision;
            debugLog("wheel.mode", {
              bufferType,
              decision,
              deltaMode: e.deltaMode,
            });
          }
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

        terminalInstanceRef.current = term;
        fitAddonRef.current = fit;
        resizeObserverRef.current = observer;
        syncTrackedBufferType("xterm.initialized");

        // Remember whether this terminal is backed by SSH for exit handling.
        isSshRef.current = !!props.ssh;

        // Create a new backend session or attach to an existing one.
        if (props.projectPath) {
          try {
            await ensureListeners();

            // Replay persisted output before deciding whether to create a live PTY.
            if (props.restoring && props.savedSessionId) {
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

              // Inactive restored tabs only replay saved output; PTY creation waits until activation.
              // The live session is created later when the tab becomes active again.
              if (!props.isActive) {
                debugLog("session.restore.defer", {
                  savedSessionId: props.savedSessionId,
                });
                console.info(`[TerminalView] Deferred restore (not active): ${props.projectPath}`);
                deferredRestoreRef.current = true;
                return;
              }
            }

            let sessionId: string;
            let effectiveResumeId = props.resumeId;

            if (props.sessionId) {
              debugLog("session.attach-existing", {
                attachSessionId: props.sessionId,
                note: "reusing existing PTY session with replay snapshot when available",
              });
              console.info(`[TerminalView] Reconnecting to existing session: ${props.sessionId}`);
              sessionId = props.sessionId;
              try {
                await replayAttachedSession({
                  term,
                  sessionId,
                  getReplaySnapshot: (attachSessionId) => terminalService.getReplaySnapshot(attachSessionId),
                  syncTrackedBufferType,
                  debugLog,
                });
              } catch (error) {
                debugLog("session.attach-existing.replay.fail", {
                  attachSessionId: props.sessionId,
                  error: getErrorMessage(error),
                });
              }
            } else {
              // Create a brand-new backend session.
              // Restored tabs may hold a stale resume id, so reload the latest one from session-state.json.
              if ((props.launchClaude || (props.cliTool && props.cliTool !== "none")) && !props.sessionId && effectiveResumeId) {
                try {
                  // When workspacePath exists, session-state.json is stored under that location.
                  const statePath = props.workspacePath || props.projectPath;
                  const state = await historyService.readSessionState(statePath);
                  if (state?.claudeSessionId && state.claudeSessionId !== "new") {
                    if (!effectiveResumeId || effectiveResumeId !== state.claudeSessionId) {
                      console.info(
                        `[TerminalView] Using session from session-state.json: ${state.claudeSessionId} (tab had: ${effectiveResumeId ?? "none"})`
                      );
                      effectiveResumeId = state.claudeSessionId;
                    }
                  }
                } catch { /* Ignore missing session-state.json. */ }
              }

              console.info(
                `[TerminalView] Creating new session: project=${props.projectPath}, launchClaude=${props.launchClaude ?? false}, resumeId=${effectiveResumeId ?? "none"}`
              );
              debugLog("session.create.begin", {
                resumeId: effectiveResumeId ?? null,
              });
              sessionId = await terminalService.createSession({
                projectPath: props.projectPath,
                cols: term.cols,
                rows: term.rows,
                workspaceName: props.workspaceName,
                providerId: props.providerId,
                workspacePath: props.workspacePath,
                launchClaude: props.launchClaude,
                cliTool: props.cliTool,
                resumeId: effectiveResumeId,
                skipMcp: props.skipMcp,
                appendSystemPrompt: props.appendSystemPrompt,
                ssh: props.ssh,
                wsl: props.wsl,
              });
              debugLog("session.create.end", {
                createdSessionId: sessionId,
              });
              console.info(`[TerminalView] Session created: ${sessionId}`);
            }

            if (!isMounted) {
              if (!props.sessionId) {
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
                usePanesStore.getState().updateTabClaudeSession(sessionId, effectiveResumeId);
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
            if (props.sessionId) {
              terminalService.resize({ sessionId, cols: term.cols, rows: term.rows });
            }
          } catch (error) {
            if (!isMounted) return;
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

    // Refit on activation and create deferred PTYs for restored tabs.
    useEffect(() => {
      debugLog("active.effect", {
        deferredRestore: deferredRestoreRef.current,
        trackedBuffer: trackedBufferTypeRef.current,
      });

      let rafId: number | null = null;
      let nestedRafId: number | null = null;
      let activationCancelled = false;

      const cancelScheduledRefit = () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (nestedRafId !== null) {
          cancelAnimationFrame(nestedRafId);
          nestedRafId = null;
        }
      };

      const refitTerminal = (): Terminal | null => {
        const term = terminalInstanceRef.current;
        const fitAddon = fitAddonRef.current;
        if (!term || !fitAddon) return null;
        fitAddon.fit();
        // Don't steal focus from input/textarea (e.g. tab rename input).
        const active = document.activeElement;
        if (!active || (active.tagName !== "INPUT" && active.tagName !== "TEXTAREA")) {
          term.focus();
        }
        const { cols, rows } = term;
        if (lastSizeRef.current?.cols !== cols || lastSizeRef.current?.rows !== rows) {
          lastSizeRef.current = { cols, rows };
          if (currentSessionIdRef.current) {
            terminalService.resize({
              sessionId: currentSessionIdRef.current,
              cols,
              rows,
            });
          }
        }
        return term;
      };

      const scheduleRefit = (onReady?: () => void) => {
        // Double-rAF waits for layout to settle after hidden-tab and split changes.
        // This keeps fit() accurate after display:none to flex transitions.
        rafId = requestAnimationFrame(() => {
          nestedRafId = requestAnimationFrame(() => {
            rafId = null;
            nestedRafId = null;
            if (activationCancelled) return;
            refitTerminal();
            onReady?.();
          });
        });
      };

      // Create the deferred PTY once the restored tab becomes active.
      if (props.isActive && deferredRestoreRef.current) {
        if (!props.projectPath) return;

        scheduleRefit(() => {
          const term = terminalInstanceRef.current;
          if (!term || isUnmountedRef.current) return;

          deferredRestoreRef.current = false;

          void (async () => {
            try {
              await ensureListeners();

              let effectiveResumeId = props.resumeId;
              if ((props.launchClaude || (props.cliTool && props.cliTool !== "none")) && effectiveResumeId) {
                try {
                  const statePath = props.workspacePath || props.projectPath;
                  const state = await historyService.readSessionState(statePath);
                  if (state?.claudeSessionId && state.claudeSessionId !== "new") {
                    if (!effectiveResumeId || effectiveResumeId !== state.claudeSessionId) {
                      console.info(
                        `[TerminalView] Using session from session-state.json: ${state.claudeSessionId} (tab had: ${effectiveResumeId ?? "none"})`
                      );
                      effectiveResumeId = state.claudeSessionId;
                    }
                  }
                } catch { /* Ignore missing session-state.json. */ }
              }

              if (isUnmountedRef.current) return;

              debugLog("session.deferred-restore.begin", {
                resumeId: effectiveResumeId ?? null,
              });
              console.info(`[TerminalView] Deferred restore: creating PTY for ${props.projectPath}`);
              const sessionId = await terminalService.createSession({
                projectPath: props.projectPath,
                cols: term.cols,
                rows: term.rows,
                workspaceName: props.workspaceName,
                providerId: props.providerId,
                workspacePath: props.workspacePath,
                launchClaude: props.launchClaude,
                cliTool: props.cliTool,
                resumeId: effectiveResumeId,
                skipMcp: props.skipMcp,
                appendSystemPrompt: props.appendSystemPrompt,
                ssh: props.ssh,
                wsl: props.wsl,
              });

              if (isUnmountedRef.current) {
                terminalService.killSession(sessionId).catch(console.error);
                return;
              }

              currentSessionIdRef.current = sessionId;
              debugLog("session.deferred-restore.end", {
                createdSessionId: sessionId,
              });
              onSessionCreatedRef.current(sessionId);
              if (effectiveResumeId && effectiveResumeId !== props.resumeId) {
                usePanesStore.getState().updateTabClaudeSession(sessionId, effectiveResumeId);
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
              console.error("[TerminalView] Deferred restore failed:", err);
              term.writeln(`\x1b[31m--- Failed to restore session: ${getErrorMessage(err)} ---\x1b[0m`);
            }
          })();
        });

        return () => {
          activationCancelled = true;
          cancelScheduledRefit();
        };
      }

      if (props.isActive && fitAddonRef.current) {
        scheduleRefit();
        return () => {
          activationCancelled = true;
          cancelScheduledRefit();
        };
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.isActive]);

    return (
      <div
        className="h-full w-full bg-[#1a1a1a] overflow-hidden flex flex-col"
        style={{ paddingTop: 'var(--notch-bar-height, 0px)' }}
      >
        <div ref={terminalRef} className="flex-1 overflow-hidden [&_.xterm]:h-full [&_.xterm]:p-1" />
      </div>
    );
  }
);

export default TerminalView;
