import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { filesystemService, providerService, terminalService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
import { noteTerminalGeometry } from "@/utils/terminalCast";
import { buildTerminalExportFileName, serializeTerminalBuffer } from "./terminalBufferSnapshot";
import { copyTerminalSelection } from "./terminalClipboard";
import { requestTerminalFitAll } from "./terminalFitEvents";
import type { TerminalRendererController } from "./terminalRendererController";

interface RefValue<T> {
  current: T;
}

interface UseTerminalContextMenuActionsOptions {
  terminalRef: RefValue<Terminal | null>;
  rendererControllerRef: RefValue<TerminalRendererController | null>;
  pasteRequestRef: RefValue<(() => void) | null>;
  currentSessionIdRef: RefValue<string | null>;
  sessionId: string | null;
  projectPath: string;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  refitAndRepaintTerminal: (
    reason: string,
    options?: { force?: boolean; focusIfSafe?: boolean; allowInactive?: boolean },
  ) => void;
  repaintTerminal: (reason: string) => void;
  /**
   * 本视图是否有权改后端 PTY 尺寸。共享 PTY 的镜像面板与只读面板必须为 false，
   * 否则镜像里点一次刷新会改掉主视图的 PTY 尺寸。缺省保守取 false。
   */
  canResizeBackend?: () => boolean;
}

/**
 * SIGWINCH 抖动的两次 resize 间隔。要大于一帧、又不至于让用户看见明显闪动。
 * 直接调 terminalService.resize（不走 layoutScheduler），否则会被它的 250ms
 * 去抖合并成一次，抖动失效。
 */
const REDRAW_NUDGE_INTERVAL_MS = 80;

export function useTerminalContextMenuActions({
  terminalRef,
  rendererControllerRef,
  pasteRequestRef,
  currentSessionIdRef,
  sessionId,
  projectPath,
  debugLog,
  refitAndRepaintTerminal,
  repaintTerminal,
  canResizeBackend = () => false,
}: UseTerminalContextMenuActionsOptions) {
  const { t } = useTranslation("panes");

  const getTerminalSelection = useCallback(
    () => terminalRef.current?.getSelection() ?? "",
    [terminalRef],
  );

  const handleMenuCopySelection = useCallback(() => {
    const term = terminalRef.current;
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
  }, [debugLog, t, terminalRef]);

  const handleMenuSelectAll = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.focus();
    term.selectAll();
  }, [terminalRef]);

  const handleMenuPaste = useCallback(() => {
    pasteRequestRef.current?.();
  }, [pasteRequestRef]);

  const getMenuSessionId = useCallback(
    () => currentSessionIdRef.current ?? sessionId ?? null,
    [currentSessionIdRef, sessionId],
  );

  /**
   * 向 CLI 请求一次全量重绘：把 PTY 宽度抖一格再抖回来，触发 SIGWINCH。
   *
   * 为什么需要它——渲染层的 clearTextureAtlas/refresh 只能重画 xterm buffer 里已有的内容，
   * 而实际错乱多半发生在 buffer 里（我们对 claude/codex 剥掉了 alt-screen，TUI 的相对定位
   * 锚点会在主缓冲区滚动时丢失，之后每帧都画错行；详见 docs/73）。只有让 CLI 自己重画才修得掉。
   * 不用 Ctrl+L：那会清屏，是破坏性操作，不该藏在"刷新显示"后面。
   */
  const requestCliRedraw = useCallback(() => {
    if (!canResizeBackend()) return;
    const term = terminalRef.current;
    const activeSessionId = currentSessionIdRef.current ?? sessionId;
    if (!term || !activeSessionId) return;

    const { cols, rows } = term;
    if (cols <= 1 || rows <= 0) return;

    const send = (nextCols: number) => {
      noteTerminalGeometry(activeSessionId, nextCols, rows);
      void terminalService
        .resize({ sessionId: activeSessionId, cols: nextCols, rows })
        .catch((error) => {
          debugLog("context-menu.refresh.resize.failed", {
            cols: nextCols,
            rows,
            error: getErrorMessage(error),
          });
        });
    };

    debugLog("context-menu.refresh.sigwinch", { cols, rows });
    send(cols - 1);
    window.setTimeout(() => {
      // 抖回来时重新取当前尺寸：这 80ms 内可能发生了真实的布局变化。
      const current = terminalRef.current;
      send(current?.cols === cols - 1 ? cols : (current?.cols ?? cols));
    }, REDRAW_NUDGE_INTERVAL_MS);
  }, [canResizeBackend, currentSessionIdRef, debugLog, sessionId, terminalRef]);

  const handleMenuRefreshTerminal = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    rendererControllerRef.current?.clearTextureAtlas("context-menu.refresh");
    refitAndRepaintTerminal("context-menu.refresh", { focusIfSafe: true });
    repaintTerminal("context-menu.refresh");
    requestCliRedraw();
  }, [
    refitAndRepaintTerminal,
    repaintTerminal,
    rendererControllerRef,
    requestCliRedraw,
    terminalRef,
  ]);

  /**
   * 重置终端缓冲区：`xterm.reset()`（清屏 + 清 scrollback + 重置终端状态）后紧跟一次
   * SIGWINCH 让 CLI 整屏重绘。这是 buffer 级错乱（docs/73 A 类）的对症药——错帧一旦
   * 沉入 scrollback，「刷新终端显示」（渲染层）与单纯 SIGWINCH（只重画视口）都救不回来。
   *
   * reset() 是破坏性重同步（回滚历史清空、不可恢复），必须经 toast 确认后执行；
   * 且只在本视图有权驱动 PTY 时提供——镜像/只读视图重置后无法触发 CLI 重绘，只会得到空屏。
   */
  const handleMenuResetBuffer = useCallback(() => {
    if (!terminalRef.current) return;
    toast.warning(t("terminalResetBufferConfirmTitle"), {
      description: t("terminalResetBufferConfirmDesc"),
      action: {
        label: t("terminalResetBufferConfirmAction"),
        onClick: () => {
          const term = terminalRef.current;
          if (!term) return;
          debugLog("context-menu.reset-buffer", {
            cols: term.cols,
            rows: term.rows,
          });
          term.reset();
          requestCliRedraw();
          term.focus();
        },
      },
    });
  }, [debugLog, requestCliRedraw, t, terminalRef]);

  const handleMenuFitTerminal = useCallback(() => {
    refitAndRepaintTerminal("context-menu.fit", {
      force: true,
      focusIfSafe: true,
      allowInactive: true,
    });
  }, [refitAndRepaintTerminal]);

  const handleMenuFitAllTerminals = useCallback(() => {
    requestTerminalFitAll();
  }, []);

  const handleMenuCopySessionId = useCallback(() => {
    const activeSessionId = currentSessionIdRef.current ?? sessionId;
    if (!activeSessionId) return;
    void copyTerminalSelection(activeSessionId)
      .then(() => toast.success(t("terminalSessionIdCopied", { id: activeSessionId })))
      .catch((error) => {
        toast.error(t("terminalCopyFailed", { error: getErrorMessage(error) }));
      });
  }, [currentSessionIdRef, sessionId, t]);

  const handleMenuClearBuffer = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.clear();
    term.focus();
  }, [terminalRef]);

  const handleMenuCopyBuffer = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    const text = serializeTerminalBuffer(term);
    if (!text) return;
    void copyTerminalSelection(text).catch((error) => {
      const message = getErrorMessage(error);
      debugLog("clipboard.copy.failed", { error: message });
      toast.error(t("terminalCopyFailed", { error: message }));
    });
  }, [debugLog, t, terminalRef]);

  const handleMenuExportBuffer = useCallback(async () => {
    const term = terminalRef.current;
    if (!term) return;
    const text = serializeTerminalBuffer(term);
    const fileName = buildTerminalExportFileName(projectPath, new Date());
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
  }, [projectPath, t, terminalRef]);

  const handleMenuOpenProjectDir = useCallback(() => {
    if (!projectPath) return;
    void providerService.openPathInExplorer(projectPath).catch((error) => {
      toast.error(t("terminalOpenDirFailed", { error: getErrorMessage(error) }));
    });
  }, [projectPath, t]);

  return {
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
  };
}
