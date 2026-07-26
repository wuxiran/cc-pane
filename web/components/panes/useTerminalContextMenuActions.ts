import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { filesystemService, providerService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
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
}

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

  const handleMenuRefreshTerminal = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    rendererControllerRef.current?.clearTextureAtlas("context-menu.refresh");
    refitAndRepaintTerminal("context-menu.refresh", { focusIfSafe: true });
    repaintTerminal("context-menu.refresh");
  }, [refitAndRepaintTerminal, repaintTerminal, rendererControllerRef, terminalRef]);

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
    handleMenuCopySessionId,
    handleMenuClearBuffer,
    handleMenuCopyBuffer,
    handleMenuExportBuffer,
    handleMenuOpenProjectDir,
  };
}
