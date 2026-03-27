import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { writeText as tauriWriteText, readText as tauriReadText } from "@tauri-apps/plugin-clipboard-manager";
import { terminalService, historyService } from "@/services";
import { ensureListeners } from "@/services/terminalService";
import { getErrorMessage } from "@/utils";
import { shouldTerminalHandleKey, useShortcutsStore, useSettingsStore, usePanesStore } from "@/stores";
import { isDragging } from "@/stores/splitDragState";
import "@xterm/xterm/css/xterm.css";

/**
 * 全局缓存 Windows Build Number（系统级常量，运行时不变）
 * 多组件实例共享，避免重复 invoke 后端。
 */
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

import type { CliTool, SshConnectionInfo } from "@/types";

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
  onSessionCreated: (sessionId: string) => void;
  onSessionExited?: (exitCode: number) => void;
  /** SSH 断线重连回调，返回新 sessionId（null 表示失败） */
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

    // SSH 断线重连状态
    const isDisconnectedRef = useRef(false);
    const isReconnectingRef = useRef(false);
    const isSshRef = useRef(!!props.ssh);

    const onSessionCreatedRef = useRef(props.onSessionCreated);
    const onSessionExitedRef = useRef(props.onSessionExited);
    const onReconnectRef = useRef(props.onReconnect);

    // 暴露方法
    useImperativeHandle(ref, () => ({
      focus: () => terminalInstanceRef.current?.focus(),
      fit: () => fitAddonRef.current?.fit(),
    }));

    // 保持 ref 与 props 同步
    useEffect(() => {
      onSessionCreatedRef.current = props.onSessionCreated;
      onSessionExitedRef.current = props.onSessionExited;
      onReconnectRef.current = props.onReconnect;
    });

    // 清理资源（按顺序：回调 → 定时器 → observer → addon → terminal）
    const cleanup = useCallback(() => {
      if (onDataDisposableRef.current) {
        onDataDisposableRef.current.dispose();
        onDataDisposableRef.current = null;
      }
      if (currentSessionIdRef.current) {
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

      // 先 dispose addon，再 dispose terminal
      const webglToDispose = webglAddonRef.current;
      const fitToDispose = fitAddonRef.current;
      const termToDispose = terminalInstanceRef.current;
      terminalInstanceRef.current = null;
      webglAddonRef.current = null;
      fitAddonRef.current = null;
      lastContainerSizeRef.current = null;

      if (webglToDispose) {
        try {
          webglToDispose.dispose();
        } catch {
          // WebGL addon dispose 可能在上下文丢失时抛错，安全忽略
        }
      }
      if (fitToDispose) {
        try {
          fitToDispose.dispose();
        } catch {
          // addon dispose 在 DOM 节点已移除时可能抛错，安全忽略
        }
      }
      if (termToDispose) {
        try {
          termToDispose.dispose();
        } catch {
          // xterm.js dispose 可能在 DOM 节点已移除时抛错，安全忽略
        }
      }
    }, []);

    /** 会话退出处理（共享逻辑：init 和 reconnect 都使用） */
    const handleSessionExit = useCallback((sessionId: string, exitCode: number) => {
      console.warn(`[TerminalView] Session exited: ${sessionId}, exitCode=${exitCode}`);
      const term = terminalInstanceRef.current;
      if (!term) return;
      term.writeln(`\r\n\x1b[33mProcess exited with code ${exitCode}\x1b[0m`);

      // SSH 终端退出后显示重连提示
      if (isSshRef.current && onReconnectRef.current) {
        term.writeln(
          "\x1b[36m[Disconnected] Press Enter to reconnect, or Ctrl+C to close.\x1b[0m"
        );
        isDisconnectedRef.current = true;
      }

      onSessionExitedRef.current?.(exitCode);
    }, []);

    /** 绑定 session 的 output/exit 回调 */
    const bindSessionCallbacks = useCallback(async (sessionId: string) => {
      await terminalService.registerOutput(sessionId, (data) => {
        terminalInstanceRef.current?.write(data);
      });
      await terminalService.registerExit(sessionId, (exitCode) => {
        handleSessionExit(sessionId, exitCode);
      });
    }, [handleSessionExit]);

    /** SSH 断线重连 */
    const doReconnect = useCallback(async () => {
      const term = terminalInstanceRef.current;
      if (!term || isReconnectingRef.current) return;
      const onReconnect = onReconnectRef.current;
      if (!onReconnect) return;

      isReconnectingRef.current = true;
      term.writeln("\r\n\x1b[33mReconnecting...\x1b[0m");

      try {
        // 解除旧 session 回调
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

        // 绑定新 session 的 output/exit 回调
        await bindSessionCallbacks(newSessionId);

        // 同步 PTY 尺寸
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

    // 初始化终端
    useEffect(() => {
      if (!terminalRef.current) return;

      let isMounted = true;

      const init = async () => {
        // 异步获取 Windows Build Number
        let buildNumber = 0;
        if (navigator.platform.startsWith('Win')) {
          buildNumber = await getCachedBuildNumber();
        }

        if (!isMounted || !terminalRef.current) return;

        const scrollback = useSettingsStore.getState().settings?.terminal?.scrollback ?? 1000;

        const term = new Terminal({
          cursorBlink: true,
          fontSize: 14,
          scrollback,
          fontFamily: 'Consolas, "Courier New", monospace',
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

        // 尝试启用 WebGL 加速渲染（GPU 加速，CPU 降低 50-70%）
        // 不可用时（如 WebGL 上下文受限）自动降级到 Canvas2D
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

        // 同步终端聚焦状态，用于控制冲突快捷键的放行
        const textarea = term.textarea;
        if (textarea) {
          const setFocused = useShortcutsStore.getState().setTerminalFocused;
          textarea.addEventListener('focus', () => setFocused(true));
          textarea.addEventListener('blur', () => setFocused(false));
        }

        // 拦截快捷键：Ctrl+C 复制 / Ctrl+V 粘贴 / 应用快捷键放行
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey) {
            // Ctrl+C: 有选区时复制到剪贴板，无选区时放行给终端（发送 SIGINT）
            if (!e.shiftKey && (e.key === 'c' || e.key === 'C')) {
              const selection = term.getSelection();
              if (selection) {
                e.preventDefault();
                // Web API 优先，WKWebView 权限拒绝时 fallback 到 Tauri plugin
                navigator.clipboard.writeText(selection)
                  .catch(() => tauriWriteText(selection).catch(() => {}));
                term.clearSelection();
                return false;
              }
              return true;
            }
            // Ctrl+V: 显式读取剪贴板粘贴，e.preventDefault() 防止浏览器 paste 事件导致粘贴两次
            if (e.key === 'v' || e.key === 'V') {
              e.preventDefault();
              // Web API 优先，WKWebView 权限拒绝时 fallback 到 Tauri plugin
              navigator.clipboard.readText()
                .then((text) => { if (text) term.paste(text); })
                .catch(() => tauriReadText().then((text) => { if (text) term.paste(text); }).catch(() => {}));
              return false;
            }
          }
          return shouldTerminalHandleKey(e);
        });

        // 适配大小
        requestAnimationFrame(() => fit.fit());

        // 监听输入（含断线重连拦截）
        const onDataDisposable = term.onData((data) => {
          // SSH 断线状态：拦截 Enter 触发重连，忽略其他输入
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

        // 监听大小变化 → 150ms 防抖 fit → resize
        // 忽略 <5px 的子像素级布局抖动，防止 ResizeObserver 自激振荡
        // 拖拽分隔线期间完全跳过 fit，由拖拽结束后的 resize 事件补偿
        const MIN_CONTAINER_CHANGE = 5;
        const observer = new ResizeObserver((entries) => {
          if (!isMounted) return;
          if (isDragging()) return; // 拖拽期间完全跳过
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

        terminalInstanceRef.current = term;
        fitAddonRef.current = fit;
        resizeObserverRef.current = observer;

        // 记录是否为 SSH 终端
        isSshRef.current = !!props.ssh;

        // 创建或重连后端会话
        if (props.projectPath) {
          try {
            await ensureListeners();

            let sessionId: string;
            let effectiveResumeId = props.resumeId;

            if (props.sessionId) {
              // 重连模式：session 已存在于后端
              console.info(`[TerminalView] Reconnecting to existing session: ${props.sessionId}`);
              sessionId = props.sessionId;
            } else {
              // 新建模式
              // 重启恢复时 tab.resumeId 可能是 stale 的，查 session-state.json 获取最新值
              if ((props.launchClaude || (props.cliTool && props.cliTool !== "none")) && !props.sessionId) {
                try {
                  // hook 写在 workspacePath（如果有），读取时也要对应
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
                } catch { /* session-state.json 不存在时忽略 */ }
              }

              console.info(
                `[TerminalView] Creating new session: project=${props.projectPath}, launchClaude=${props.launchClaude ?? false}, resumeId=${effectiveResumeId ?? "none"}`
              );
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

            if (!props.sessionId) {
              onSessionCreatedRef.current(sessionId);
              // 如果 session-state.json 纠正了 resumeId，回写 store 以确保持久化
              if (effectiveResumeId && effectiveResumeId !== props.resumeId) {
                usePanesStore.getState().updateTabClaudeSession(sessionId, effectiveResumeId);
              }
            }

            // 注册输出/退出回调
            await bindSessionCallbacks(sessionId);
            if (!isMounted) {
              terminalService.detachOutput(sessionId);
              terminalService.detachExit(sessionId);
              return;
            }

            // 重连时同步 PTY 尺寸
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
        cleanup();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 激活时重新适配大小 + 聚焦
    useEffect(() => {
      if (props.isActive && fitAddonRef.current) {
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
          terminalInstanceRef.current?.focus();
        });
      }
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
