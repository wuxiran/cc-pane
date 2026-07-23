import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { handleError, handleErrorSilent, isTauriRuntime } from "@/utils";
import {
  FilePlus, FolderPlus, RefreshCw, ChevronsDownUp, Crosshair, Home, Link, Link2Off,
  ArrowLeft, ArrowRight, ArrowUp,
} from "lucide-react";
import { useFileBrowserStore, useWorkspacesStore } from "@/stores";
import { selfChatService, settingsService } from "@/services";
import { useFileTreeStore } from "@/stores/useFileTreeStore";
import { FileTree } from "@/components/filetree";
import { homeDir } from "@tauri-apps/api/path";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFileBrowserFollow } from "@/hooks/useFileBrowserFollow";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function FileBrowserView() {
  const { t } = useTranslation(["sidebar", "common"]);
  useFileBrowserFollow();

  const currentPath = useFileBrowserStore((s) => s.currentPath);
  const followTerminal = useFileBrowserStore((s) => s.followTerminal);
  const setFollowTerminal = useFileBrowserStore((s) => s.setFollowTerminal);
  const navigateTo = useFileBrowserStore((s) => s.navigateTo);
  const goBack = useFileBrowserStore((s) => s.goBack);
  const goForward = useFileBrowserStore((s) => s.goForward);
  const goUp = useFileBrowserStore((s) => s.goUp);
  const canGoBack = useFileBrowserStore((s) => s.canGoBack);
  const canGoForward = useFileBrowserStore((s) => s.canGoForward);
  const refreshKey = useFileBrowserStore((s) => s.refreshKey);
  const clearTree = useFileTreeStore((s) => s.clearTree);
  const refresh = useFileTreeStore((s) => s.refresh);
  const loadGitStatuses = useFileTreeStore((s) => s.loadGitStatuses);
  const collapseAll = useFileTreeStore((s) => s.collapseAll);
  const revealFile = useFileTreeStore((s) => s.revealFile);
  const selectedFilePath = useFileTreeStore((s) => s.selectedFilePath);
  const createFile = useFileTreeStore((s) => s.createFile);
  const createDirectory = useFileTreeStore((s) => s.createDirectory);

  const [dialogType, setDialogType] = useState<"newFile" | "newDir" | null>(null);
  const [inputValue, setInputValue] = useState("");

  // 初始路径：持久化路径 → 应用工作目录（与自我对话一致）→ 工作空间路径 → home 目录
  useEffect(() => {
    if (currentPath) return;
    selfChatService.getAppCwd().then((cwd) => {
      if (!useFileBrowserStore.getState().currentPath) navigateTo(cwd);
    }).catch(() => {
      const ws = useWorkspacesStore.getState().selectedWorkspace();
      if (ws?.path) {
        if (!useFileBrowserStore.getState().currentPath) navigateTo(ws.path);
      } else if (isTauriRuntime()) {
        homeDir().then((home) => {
          if (home && !useFileBrowserStore.getState().currentPath) {
            navigateTo(home.replace(/\\/g, "/").replace(/\/+$/, ""));
          }
        }).catch((e) => handleErrorSilent(e, "get home dir"));
      }
    });
  }, [currentPath, navigateTo]);

  // 刷新时清除 FileTree 缓存
  useEffect(() => {
    if (refreshKey > 0 && currentPath) {
      clearTree(currentPath);
    }
  }, [refreshKey, currentPath, clearTree]);

  const handleRefresh = useCallback(() => {
    if (!currentPath) return;
    refresh(currentPath).catch((err) => {
      handleError(err, "refresh file tree");
    });
    loadGitStatuses(currentPath).catch(() => {});
  }, [currentPath, refresh, loadGitStatuses]);

  const handleCollapseAll = useCallback(() => {
    if (!currentPath) return;
    collapseAll(currentPath);
  }, [currentPath, collapseAll]);

  const handleGoHome = useCallback(() => {
    if (!isTauriRuntime()) {
      selfChatService.getAppCwd().then((cwd) => {
        navigateTo(cwd);
      }).catch((err) => handleErrorSilent(err, "get app cwd"));
      return;
    }
    settingsService.getDataDirInfo().then((info) => {
      navigateTo(info.currentPath);
    }).catch((err) => handleErrorSilent(err, "get app data dir"));
  }, [navigateTo]);

  const handleRevealFile = useCallback(() => {
    if (!currentPath || !selectedFilePath) return;
    revealFile(currentPath, selectedFilePath).catch((e) => handleErrorSilent(e, "reveal file"));
  }, [currentPath, selectedFilePath, revealFile]);

  const handleNewFile = useCallback(() => {
    setInputValue("");
    setDialogType("newFile");
  }, []);

  const handleNewFolder = useCallback(() => {
    setInputValue("");
    setDialogType("newDir");
  }, []);

  const handleDialogSubmit = useCallback(async () => {
    if (!inputValue.trim() || !currentPath) return;
    try {
      if (dialogType === "newFile") {
        await createFile(currentPath, inputValue.trim(), currentPath);
        toast.success(t("filetree.created", { name: inputValue.trim() }));
      } else if (dialogType === "newDir") {
        await createDirectory(currentPath, inputValue.trim(), currentPath);
        toast.success(t("filetree.created", { name: inputValue.trim() }));
      }
    } catch (err) {
      handleError(err, "create file/directory");
    }
    setDialogType(null);
  }, [dialogType, inputValue, currentPath, createFile, createDirectory]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 标题栏 + 工具栏 */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0 group/toolbar">
        <span className="text-xs font-semibold uppercase tracking-widest text-[var(--app-text-tertiary)]">
          {t("fileBrowser")}
        </span>

        {/* 工具栏按钮 - hover 时显示 */}
        {currentPath && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover/toolbar:opacity-100 transition-opacity">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1 rounded-md transition-colors hover:bg-[var(--app-hover)] focus:outline-none disabled:opacity-30"
                  style={{ color: "var(--app-text-secondary)" }}
                  onClick={goBack}
                  disabled={!canGoBack()}
                >
                  <ArrowLeft size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{t("goBack")}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1 rounded-md transition-colors hover:bg-[var(--app-hover)] focus:outline-none disabled:opacity-30"
                  style={{ color: "var(--app-text-secondary)" }}
                  onClick={goForward}
                  disabled={!canGoForward()}
                >
                  <ArrowRight size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{t("goForward")}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1 rounded-md transition-colors hover:bg-[var(--app-hover)] focus:outline-none disabled:opacity-30"
                  style={{ color: "var(--app-text-secondary)" }}
                  onClick={goUp}
                  disabled={!currentPath || currentPath === "/" || /^[A-Z]:[\\/]?$/i.test(currentPath)}
                >
                  <ArrowUp size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{t("goUp")}</p>
              </TooltipContent>
            </Tooltip>

            <div className="w-px h-3 bg-[var(--app-border)] mx-0.5" />

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1 rounded-md transition-colors hover:bg-[var(--app-hover)] focus:outline-none"
                  style={{ color: "var(--app-text-secondary)" }}
                  onClick={handleGoHome}
                >
                  <Home size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{t("goToProjectRoot")}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1 rounded-md transition-colors hover:bg-[var(--app-hover)] focus:outline-none"
                  style={{ color: "var(--app-text-secondary)" }}
                  onClick={handleNewFile}
                >
                  <FilePlus size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{t("filetree.newFile")}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1 rounded-md transition-colors hover:bg-[var(--app-hover)] focus:outline-none"
                  style={{ color: "var(--app-text-secondary)" }}
                  onClick={handleNewFolder}
                >
                  <FolderPlus size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{t("filetree.newFolder")}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1 rounded-md transition-colors hover:bg-[var(--app-hover)] focus:outline-none"
                  style={{ color: "var(--app-text-secondary)" }}
                  onClick={handleRefresh}
                >
                  <RefreshCw size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{t("refresh")}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1 rounded-md transition-colors hover:bg-[var(--app-hover)] focus:outline-none"
                  style={{ color: "var(--app-text-secondary)" }}
                  onClick={handleCollapseAll}
                >
                  <ChevronsDownUp size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{t("collapseAll")}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1 rounded-md transition-colors hover:bg-[var(--app-hover)] focus:outline-none disabled:opacity-30"
                  style={{ color: "var(--app-text-secondary)" }}
                  onClick={handleRevealFile}
                  disabled={!selectedFilePath}
                >
                  <Crosshair size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{t("revealActiveFile")}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t("followTerminal")}
                  aria-pressed={followTerminal}
                  className="p-1 rounded-md transition-colors hover:bg-[var(--app-hover)] focus:outline-none"
                  style={{
                    color: followTerminal ? "var(--app-accent)" : "var(--app-text-secondary)",
                  }}
                  onClick={() => setFollowTerminal(!followTerminal)}
                >
                  {followTerminal ? <Link size={14} /> : <Link2Off size={14} />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{t(followTerminal ? "stopFollowingTerminal" : "followTerminal")}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* 文件树 */}
      <div className="flex-1 overflow-hidden">
        {currentPath ? (
          <FileTree
            key={`${currentPath}-${refreshKey}`}
            rootPath={currentPath}
            compact={false}
            onNavigateToDir={navigateTo}
          />
        ) : (
          <div className="text-xs text-center py-8 text-muted-foreground">
            {t("noPath")}
          </div>
        )}
      </div>

      {/* 新建文件/文件夹对话框 */}
      <Dialog open={dialogType !== null} onOpenChange={() => setDialogType(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogType === "newFile" ? t("filetree.dialogNewFile") : t("filetree.dialogNewFolder")}
            </DialogTitle>
          </DialogHeader>
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleDialogSubmit()}
            placeholder={dialogType === "newFile" ? "filename.ext" : "folder-name"}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogType(null)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleDialogSubmit}>{t("common:create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
