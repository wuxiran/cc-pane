import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  FilePlus, FolderPlus, RefreshCw, ChevronsDownUp, Crosshair,
} from "lucide-react";
import { useFileBrowserStore, useWorkspacesStore } from "@/stores";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function FileBrowserView() {
  const { t } = useTranslation("sidebar");

  const currentPath = useFileBrowserStore((s) => s.currentPath);
  const navigateTo = useFileBrowserStore((s) => s.navigateTo);
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

  // 初始路径：如果没有保存的路径，使用工作空间路径或 home 目录
  useEffect(() => {
    if (currentPath) return;
    const ws = useWorkspacesStore.getState().selectedWorkspace();
    if (ws?.path) {
      navigateTo(ws.path);
    } else {
      homeDir().then((home) => {
        if (home) navigateTo(home.replace(/\\/g, "/").replace(/\/+$/, ""));
      }).catch(console.error);
    }
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
      toast.error(`Refresh failed: ${err}`);
    });
    loadGitStatuses(currentPath).catch(() => {});
  }, [currentPath, refresh, loadGitStatuses]);

  const handleCollapseAll = useCallback(() => {
    if (!currentPath) return;
    collapseAll(currentPath);
  }, [currentPath, collapseAll]);

  const handleRevealFile = useCallback(() => {
    if (!currentPath || !selectedFilePath) return;
    revealFile(currentPath, selectedFilePath).catch(console.error);
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
        toast.success(`Created: ${inputValue.trim()}`);
      } else if (dialogType === "newDir") {
        await createDirectory(currentPath, inputValue.trim(), currentPath);
        toast.success(`Created: ${inputValue.trim()}`);
      }
    } catch (err) {
      toast.error(`Operation failed: ${err}`);
    }
    setDialogType(null);
  }, [dialogType, inputValue, currentPath, createFile, createDirectory]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 标题栏 + 工具栏 */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0 group/toolbar">
        <span className="text-xs font-semibold uppercase tracking-widest text-[var(--app-text-tertiary)]">
          {t("fileBrowser", { defaultValue: "Files" })}
        </span>

        {/* 工具栏按钮 - hover 时显示 */}
        {currentPath && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover/toolbar:opacity-100 transition-opacity">
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
                <p>New File</p>
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
                <p>New Folder</p>
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
                <p>Refresh</p>
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
                <p>Collapse All</p>
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
                <p>Reveal Active File</p>
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
            {t("noPath", { defaultValue: "Select a directory to browse" })}
          </div>
        )}
      </div>

      {/* 新建文件/文件夹对话框 */}
      <Dialog open={dialogType !== null} onOpenChange={() => setDialogType(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogType === "newFile" ? "New File" : "New Folder"}
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
              Cancel
            </Button>
            <Button onClick={handleDialogSubmit}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
