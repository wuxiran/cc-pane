import { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Search, ChevronUp, ChevronDown, X } from "lucide-react";
import { terminalService } from "@/services";
import { shouldTerminalHandleKey } from "@/stores";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  sessionId: string | null;
  projectPath: string;
  isActive: boolean;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
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
    const searchInputRef = useRef<HTMLInputElement>(null);
    const terminalInstanceRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const outputUnlistenRef = useRef<UnlistenFn | null>(null);
    const exitUnlistenRef = useRef<UnlistenFn | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const currentSessionIdRef = useRef<string | null>(null);

    const onSessionCreatedRef = useRef(props.onSessionCreated);
    const onSessionExitedRef = useRef(props.onSessionExited);

    const [showSearch, setShowSearch] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");

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
      if (outputUnlistenRef.current) {
        outputUnlistenRef.current();
        outputUnlistenRef.current = null;
      }
      if (exitUnlistenRef.current) {
        exitUnlistenRef.current();
        exitUnlistenRef.current = null;
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (currentSessionIdRef.current) {
        terminalService.kill(currentSessionIdRef.current).catch(console.error);
        currentSessionIdRef.current = null;
      }
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.dispose();
        terminalInstanceRef.current = null;
      }
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    }, []);

    // 初始化终端
    useEffect(() => {
      if (!terminalRef.current) return;

      let isMounted = true;
      let autoExecTimer: ReturnType<typeof setTimeout> | null = null;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Consolas, "Courier New", monospace',
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

      const search = new SearchAddon();
      term.loadAddon(search);

      term.open(terminalRef.current);

      // 拦截已注册快捷键
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        return shouldTerminalHandleKey(e);
      });

      // 适配大小
      requestAnimationFrame(() => fit.fit());

      // 监听输入
      term.onData((data) => {
        if (currentSessionIdRef.current) {
          terminalService.write(currentSessionIdRef.current, data);
        }
      });

      // 监听大小变化
      const observer = new ResizeObserver(() => {
        if (fitAddonRef.current && terminalInstanceRef.current) {
          fitAddonRef.current.fit();
          if (currentSessionIdRef.current) {
            terminalService.resize({
              sessionId: currentSessionIdRef.current,
              cols: terminalInstanceRef.current.cols,
              rows: terminalInstanceRef.current.rows,
            });
          }
        }
      });
      observer.observe(terminalRef.current);

      terminalInstanceRef.current = term;
      fitAddonRef.current = fit;
      searchAddonRef.current = search;
      resizeObserverRef.current = observer;

      // 创建后端会话
      if (props.projectPath) {
        terminalService
          .createSession({
            projectPath: props.projectPath,
            cols: term.cols,
            rows: term.rows,
            workspaceName: props.workspaceName,
            providerId: props.providerId,
          })
          .then(async (sessionId) => {
            if (!isMounted) {
              // 组件已卸载，立即 kill 新创建的 session
              terminalService.kill(sessionId).catch(console.error);
              return;
            }

            currentSessionIdRef.current = sessionId;
            onSessionCreatedRef.current(sessionId);

            // 监听输出
            const outputUn = await terminalService.onOutput(
              (sid, data) => {
                if (sid === currentSessionIdRef.current && terminalInstanceRef.current) {
                  terminalInstanceRef.current.write(data);
                }
              }
            );
            if (!isMounted) {
              outputUn();
              return;
            }
            outputUnlistenRef.current = outputUn;

            // 监听退出
            const exitUn = await terminalService.onExit(
              (sid, exitCode) => {
                if (sid === currentSessionIdRef.current) {
                  terminalInstanceRef.current?.writeln(
                    `\r\n\x1b[33mProcess exited with code ${exitCode}\x1b[0m`
                  );
                  onSessionExitedRef.current?.(exitCode);
                }
              }
            );
            if (!isMounted) {
              exitUn();
              return;
            }
            exitUnlistenRef.current = exitUn;

            // 自动执行 claude 命令
            if (props.resumeId) {
              autoExecTimer = setTimeout(() => {
                if (!isMounted) return;
                let cmd: string;
                if (props.resumeId === "new") {
                  cmd = "claude\r";
                } else {
                  cmd = `claude --resume ${props.resumeId}\r`;
                }
                terminalService.write(sessionId, cmd);
              }, 500);
            }
          })
          .catch((error) => {
            if (!isMounted) return;
            console.error("Failed to create terminal session:", error);
            term.writeln(
              `\x1b[31mFailed to create terminal session: ${error}\x1b[0m`
            );
          });
      }

      return () => {
        isMounted = false;
        if (autoExecTimer) clearTimeout(autoExecTimer);
        cleanup();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // 只在挂载时初始化一次

    // 激活时重新适配大小
    useEffect(() => {
      if (props.isActive && fitAddonRef.current) {
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
          terminalInstanceRef.current?.focus();
        });
      }
    }, [props.isActive]);

    // 全局 Ctrl+F 搜索
    useEffect(() => {
      function handleGlobalKeydown(e: KeyboardEvent) {
        if ((e.ctrlKey || e.metaKey) && e.key === "f" && props.isActive) {
          e.preventDefault();
          setShowSearch(true);
          requestAnimationFrame(() => searchInputRef.current?.focus());
        }
      }
      document.addEventListener("keydown", handleGlobalKeydown);
      return () => document.removeEventListener("keydown", handleGlobalKeydown);
    }, [props.isActive]);

    function closeSearch() {
      setShowSearch(false);
      setSearchQuery("");
      terminalInstanceRef.current?.focus();
    }

    function findNext() {
      if (searchAddonRef.current && searchQuery) {
        searchAddonRef.current.findNext(searchQuery);
      }
    }

    function findPrevious() {
      if (searchAddonRef.current && searchQuery) {
        searchAddonRef.current.findPrevious(searchQuery);
      }
    }

    function handleSearchKeydown(e: React.KeyboardEvent) {
      if (e.key === "Enter") {
        e.shiftKey ? findPrevious() : findNext();
      } else if (e.key === "Escape") {
        closeSearch();
      }
    }

    return (
      <div className="h-full w-full bg-[#1a1a1a] overflow-hidden flex flex-col">
        {/* 搜索栏 */}
        {showSearch && (
          <div className="flex items-center gap-1 px-2 py-1.5 bg-[#2a2a2a] border-b border-[#3a3a3a]">
            <Search size={14} className="text-[#6e6e73] shrink-0" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (searchAddonRef.current && e.target.value) {
                  searchAddonRef.current.findNext(e.target.value);
                }
              }}
              type="text"
              placeholder="搜索..."
              className="flex-1 bg-[#1a1a1a] border border-[#3a3a3a] rounded px-2 py-1 text-[#f5f5f7] text-xs outline-none focus:border-[#0a84ff] placeholder:text-[#6e6e73]"
              onKeyDown={handleSearchKeydown}
            />
            <button
              className="w-6 h-6 flex items-center justify-center bg-transparent border-none rounded text-[#8e8e93] cursor-pointer hover:bg-[#3a3a3a] hover:text-[#f5f5f7]"
              onClick={findPrevious}
              title="上一个 (Shift+Enter)"
            >
              <ChevronUp size={14} />
            </button>
            <button
              className="w-6 h-6 flex items-center justify-center bg-transparent border-none rounded text-[#8e8e93] cursor-pointer hover:bg-[#3a3a3a] hover:text-[#f5f5f7]"
              onClick={findNext}
              title="下一个 (Enter)"
            >
              <ChevronDown size={14} />
            </button>
            <button
              className="w-6 h-6 flex items-center justify-center bg-transparent border-none rounded text-[#8e8e93] cursor-pointer hover:bg-[#3a3a3a] hover:text-[#ff453a]"
              onClick={closeSearch}
              title="关闭 (Esc)"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div ref={terminalRef} className="flex-1 overflow-hidden [&_.xterm]:h-full [&_.xterm]:p-1" />
      </div>
    );
  }
);

export default TerminalView;
