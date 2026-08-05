import { Code2, Copy, ExternalLink, FolderOpen, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { terminalPathLinkService } from "@/services/terminalPathLinkService";
import { isTauriRuntime } from "@/services/runtime";
import { isImageFile } from "@/lib/fileTypes";
import { useEditorRevealStore } from "@/stores/useEditorRevealStore";
import { usePanesStore } from "@/stores/usePanesStore";
import { useTerminalPathLinkStore, type TerminalPathLinkAction } from "@/stores/useTerminalPathLinkStore";
import { translateError } from "@/utils";

function fileName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function displayPath(path: string, line?: number, column?: number): string {
  if (line === undefined) return path;
  return `${path}:${line}${column === undefined ? "" : `:${column}`}`;
}

function editorProjectPath(sessionId: string, canonicalPath: string): string {
  const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
  return location?.tab.projectPath
    ?? canonicalPath.replace(/[/\\][^/\\]+$/, "");
}

export default function TerminalPathLinkDialog() {
  const { t } = useTranslation("panes");
  const dialog = useTerminalPathLinkStore((state) => state.dialog);
  const desktop = isTauriRuntime();
  const open = dialog.phase !== "closed";
  const acting = dialog.phase === "acting";
  const ready = dialog.phase === "ready" || acting;

  const runAction = (
    action: TerminalPathLinkAction,
    runner: () => Promise<void>,
    closeOnSuccess = true,
  ) => {
    void useTerminalPathLinkStore.getState().runAction(action, runner, closeOnSuccess).catch((error) => {
      toast.error(t("terminalPathLink.actionFailed", { error: translateError(error) }));
    });
  };

  const openEditor = () => {
    if (!ready || dialog.kind !== "file") return;
    runAction("openEditor", async () => {
      if (dialog.line !== undefined && !isImageFile(dialog.canonicalPath)) {
        useEditorRevealStore.getState().request(
          dialog.canonicalPath,
          dialog.line,
          dialog.column,
        );
      }
      usePanesStore.getState().openEditor(
        editorProjectPath(dialog.sessionId, dialog.canonicalPath),
        dialog.canonicalPath,
        fileName(dialog.canonicalPath),
      );
    });
  };

  const runDesktopAction = (action: "openDefault" | "reveal") => {
    if (!ready) return;
    runAction(action, () => terminalPathLinkService.runDesktopAction({
      sessionId: dialog.sessionId,
      rawPath: dialog.rawPath,
      action,
    }));
  };

  const copyPath = () => {
    if (!ready) return;
    runAction("copy", async () => {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable");
      }
      await navigator.clipboard.writeText(dialog.canonicalPath);
      toast.success(t("terminalPathLink.copied"));
    }, false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) useTerminalPathLinkStore.getState().close();
      }}
    >
      <DialogContent className="sm:max-w-[440px]" aria-busy={dialog.phase === "resolving"}>
        <DialogHeader>
          <DialogTitle>
            {ready
              ? t(dialog.kind === "file" ? "terminalPathLink.fileTitle" : "terminalPathLink.directoryTitle")
              : t("terminalPathLink.resolvingTitle")}
          </DialogTitle>
          <DialogDescription>
            {ready
              ? t(dialog.kind === "file" ? "terminalPathLink.fileDescription" : "terminalPathLink.directoryDescription")
              : t("terminalPathLink.resolvingDescription")}
          </DialogDescription>
        </DialogHeader>

        {dialog.phase !== "closed" && (
          <div className="min-w-0 select-text break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs leading-5">
            {displayPath(ready ? dialog.canonicalPath : dialog.rawPath, dialog.line, dialog.column)}
          </div>
        )}

        {dialog.phase === "resolving" ? (
          <div className="flex h-12 items-center justify-center text-muted-foreground" role="status">
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            <span className="sr-only">{t("terminalPathLink.resolvingDescription")}</span>
          </div>
        ) : ready ? (
          <DialogFooter className="sm:flex-wrap">
            {dialog.kind === "file" && (
              <Button onClick={openEditor} disabled={acting}>
                {acting && dialog.pendingAction === "openEditor" ? <Loader2 className="animate-spin" /> : <Code2 />}
                {t("terminalPathLink.openEditor")}
              </Button>
            )}
            {desktop && dialog.kind === "file" && (
              <Button variant="outline" onClick={() => runDesktopAction("openDefault")} disabled={acting}>
                {acting && dialog.pendingAction === "openDefault" ? <Loader2 className="animate-spin" /> : <ExternalLink />}
                {t("terminalPathLink.openDefault")}
              </Button>
            )}
            {desktop && (
              <Button
                variant={dialog.kind === "directory" ? "default" : "outline"}
                onClick={() => runDesktopAction("reveal")}
                disabled={acting}
              >
                {acting && dialog.pendingAction === "reveal" ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                {t(dialog.kind === "directory" ? "terminalPathLink.openFolder" : "terminalPathLink.reveal")}
              </Button>
            )}
            <Button
              variant={!desktop && dialog.kind === "directory" ? "default" : "outline"}
              onClick={copyPath}
              disabled={acting}
            >
              {acting && dialog.pendingAction === "copy" ? <Loader2 className="animate-spin" /> : <Copy />}
              {t("terminalPathLink.copy")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
