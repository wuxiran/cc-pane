import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalService } from "@/services";
import { ensureListeners } from "@/services/terminalService";
import { shouldTerminalHandleKey, useShortcutsStore } from "@/stores";
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

interface TerminalViewProps {
  sessionId: string | null;
  projectPath: string;
  isActive: boolean;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
  launchClaude?: boolean;
  resumeId?: string;
  onSessionCreated: (sessionId: string) => void;
  onSessionExited?: (exitCode: number) => void;
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
    const onDataDisposableRef = useRef<IDisposable | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const currentSessionIdRef = useRef<string | null>(null);
    const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const lastContainerSizeRef = useRef<{ width: number; height: number } | null>(null);

    const onSessionCreatedRef = useRef(props.onSessionCreated);
    const onSessionExitedRef = useRef(props.onSessionExited);

    // 暴露方法
    useImperativeHandle(ref, () => ({
      focus: () => terminalInstanceRef.current?.focus(),
      fit: () => fitAddonRef.current?.fit(),
    }));

    // 保持 ref 与 props 同步
    useEffect(() => {
      onSessionCreatedRef.current = props.onSessionCreated;
      onSessionExitedRef.current = props.onSessionExited;
    });

    // 清理资源
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

      const termToDispose = terminalInstanceRef.current;
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
      lastContainerSizeRef.current = null;

      if (termToDispose) {
        try {
          termToDispose.dispose();
        } catch {
          // xterm.js dispose 可能在 DOM 节点已移除时抛错，安全忽略
        }
      }
    }, []);

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

        const term = new Terminal({
          cursorBlink: true,
          fontSize: 14,
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

        // 同步终端聚焦状态，用于控制冲突快捷键的放行
        const textarea = term.textarea;
        if (textarea) {
          const setFocused = useShortcutsStore.getState().setTerminalFocused;
          textarea.addEventListener('focus', () => setFocused(true));
          textarea.addEventListener('blur', () => setFocused(false));
        }

        // 拦截已注册的应用快捷键（Ctrl+T/Ctrl+W 等），防止终端吞掉
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          // Ctrl+V / Ctrl+Shift+V: 显式处理粘贴
          // 防止 xterm.js 在 TUI 模式下将 Ctrl+V 作为 ^V (0x16) 发送到 PTY
          if (
            e.type === 'keydown' &&
            (e.ctrlKey || e.metaKey) &&
            !e.altKey &&
            (e.key === 'v' || e.key === 'V')
          ) {
            navigator.clipboard
              .readText()
              .then((text) => {
                if (text) term.paste(text);
              })
              .catch(() => {});
            return false;
          }
          return shouldTerminalHandleKey(e);
        });

        // 适配大小
        requestAnimationFrame(() => fit.fit());

        // 监听输入
        const onDataDisposable = term.onData((data) => {
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

        // 创建或重连后端会话
        if (props.projectPath) {
          try {
            await ensureListeners();

            let sessionId: string;

            if (props.sessionId) {
              // 重连模式：session 已存在于后端
              console.info(`[TerminalView] Reconnecting to existing session: ${props.sessionId}`);
              sessionId = props.sessionId;
            } else {
              // 新建模式
              console.info(
                `[TerminalView] Creating new session: project=${props.projectPath}, launchClaude=${props.launchClaude ?? false}, resumeId=${props.resumeId ?? "none"}`
              );
              sessionId = await terminalService.createSession({
                projectPath: props.projectPath,
                cols: term.cols,
                rows: term.rows,
                workspaceName: props.workspaceName,
                providerId: props.providerId,
                workspacePath: props.workspacePath,
                launchClaude: props.launchClaude,
                resumeId: props.resumeId,
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
            }

            // 注册输出回调（registerOutput 会自动 flush pendingBuffers）
            await terminalService.registerOutput(sessionId, (data) => {
              terminalInstanceRef.current?.write(data);
            });
            if (!isMounted) { terminalService.detachOutput(sessionId); return; }

            // 注册退出回调
            await terminalService.registerExit(sessionId, (exitCode) => {
              console.warn(`[TerminalView] Session exited: ${sessionId}, exitCode=${exitCode}, launchClaude=${props.launchClaude ?? false}`);
              terminalInstanceRef.current?.writeln(
                `\r\n\x1b[33mProcess exited with code ${exitCode}\x1b[0m`
              );
              onSessionExitedRef.current?.(exitCode);
            });
            if (!isMounted) { terminalService.detachExit(sessionId); return; }

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
            const errorMsg = String(error);
            if (errorMsg.includes("claude CLI not found")) {
              console.error("[TerminalView] Claude CLI not found in PATH");
              term.writeln(
                `\x1b[31mclaude CLI is not installed or not in PATH.\x1b[0m`
              );
              term.writeln(
                `\x1b[33mPlease install: npm install -g @anthropic-ai/claude-code\x1b[0m`
              );
            } else {
              term.writeln(
                `\x1b[31mFailed to initialize terminal session: ${error}\x1b[0m`
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
      <div className="h-full w-full bg-[#1a1a1a] overflow-hidden flex flex-col">
        <div ref={terminalRef} className="flex-1 overflow-hidden [&_.xterm]:h-full [&_.xterm]:p-1" />
      </div>
    );
  }
);

export default TerminalView;
