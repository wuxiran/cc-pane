import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toastInfo, toastOk } from "@/lib/feedback";
import { handleError, getErrorCode, isWslUncPath } from "@/utils";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuTrigger, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/sidebar/WorkspaceDialogs";
import { Input } from "@/components/ui/input";
import {
  FileEdit, Trash2, Copy, Move, FolderPlus, FilePlus,
  ExternalLink, ClipboardCopy, FileSymlink, Terminal, RefreshCw,
} from "lucide-react";
import { useFileTreeStore } from "@/stores";
import { usePanesStore } from "@/stores";
import type { FileTreeNode } from "@/types/filesystem";
import { isTauriRuntime } from "@/services/runtime";
import { providerService } from "@/services/providerService";
import { handleErrorSilent } from "@/utils/errorHandler";

/** 暴露给父级的键盘操作入口（如 F2 重命名），复用右键菜单的对话框流程 */
export interface FileTreeContextMenuApi {
  openRename: () => void;
}

interface FileTreeContextMenuProps {
  children: React.ReactNode;
  nodeRef: React.MutableRefObject<FileTreeNode | null>;
  rootPath: string;
  onOpenTerminal?: (path: string) => void;
  /** 可选：挂载后写入 { openRename }，卸载时清空 */
  apiRef?: React.MutableRefObject<FileTreeContextMenuApi | null>;
}

export default function FileTreeContextMenu({
  children,
  nodeRef,
  rootPath,
  onOpenTerminal,
  apiRef,
}: FileTreeContextMenuProps) {
  const { t } = useTranslation(["sidebar", "common"]);

  const [dialogType, setDialogType] = useState<"rename" | "newFile" | "newDir" | "move" | "copy" | null>(null);
  const [inputValue, setInputValue] = useState("");
  // 对话框打开时快照 node，避免后续右键改变 nodeRef 影响
  const dialogNodeRef = useRef<FileTreeNode | null>(null);

  // 删除确认对话框状态
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // 回收站不可用时的永久删除二次确认
  const [confirmPermanentOpen, setConfirmPermanentOpen] = useState(false);
  const pendingDeleteNodeRef = useRef<FileTreeNode | null>(null);

  const deleteEntry = useFileTreeStore((s) => s.deleteEntry);
  const renameEntry = useFileTreeStore((s) => s.renameEntry);
  const createFile = useFileTreeStore((s) => s.createFile);
  const createDirectory = useFileTreeStore((s) => s.createDirectory);
  const copyEntry = useFileTreeStore((s) => s.copyEntry);
  const moveEntry = useFileTreeStore((s) => s.moveEntry);
  const openEditor = usePanesStore((s) => s.openEditor);

  const node = nodeRef.current;

  const handleOpenEditor = useCallback(() => {
    const n = nodeRef.current;
    if (!n || n.entry.isDir) return;
    openEditor(rootPath, n.entry.path, n.entry.name);
  }, [rootPath, openEditor, nodeRef]);

  const handleOpenInExplorer = useCallback(async () => {
    const n = nodeRef.current;
    if (!n) return;
    if (!isTauriRuntime()) {
      toastInfo(t("sidebar:filetree.pathCopied"));
      await navigator.clipboard.writeText(n.entry.path);
      return;
    }
    try {
      await providerService.openPathInExplorer(n.entry.path);
    } catch (err) {
      handleError(err, "open in explorer");
    }
  }, [nodeRef]);

  const handleCopyPath = useCallback(() => {
    const n = nodeRef.current;
    if (!n) return;
    navigator.clipboard.writeText(n.entry.path);
    toastOk(t("sidebar:filetree.pathCopied"));
  }, [nodeRef, t]);

  const handleCopyRelativePath = useCallback(() => {
    const n = nodeRef.current;
    if (!n) return;
    const normalizedPath = n.entry.path.replace(/\\/g, "/");
    const normalizedRoot = rootPath.replace(/\\/g, "/");
    const relativePath = normalizedPath.startsWith(normalizedRoot)
      ? normalizedPath.slice(normalizedRoot.length).replace(/^\//, "")
      : n.entry.path;
    navigator.clipboard.writeText(relativePath);
    toastOk(t("sidebar:filetree.relativePathCopied"));
  }, [nodeRef, rootPath, t]);

  const handleDelete = useCallback(() => {
    const n = nodeRef.current;
    if (!n) return;
    pendingDeleteNodeRef.current = n;
    setConfirmDeleteOpen(true);
  }, [nodeRef]);

  const doDelete = useCallback(async () => {
    const n = pendingDeleteNodeRef.current;
    if (!n) return;
    // WSL UNC 路径没有回收站，trash 必然失败且有秒级延迟，直接永久删除
    const permanent = isWslUncPath(n.entry.path);
    try {
      await deleteEntry(n.entry.path, rootPath, permanent);
      toastOk(t("sidebar:filetree.deleted", { name: n.entry.name }));
    } catch (err) {
      if (getErrorCode(err) === "TRASH_FAILED") {
        // 回收站不可用（占用/无回收站卷）→ 保留待删节点，转入永久删除确认
        setConfirmDeleteOpen(false);
        setConfirmPermanentOpen(true);
        return;
      }
      handleError(err, "delete entry");
    }
    setConfirmDeleteOpen(false);
    pendingDeleteNodeRef.current = null;
  }, [rootPath, deleteEntry, t]);

  const doPermanentDelete = useCallback(async () => {
    const n = pendingDeleteNodeRef.current;
    if (!n) return;
    try {
      await deleteEntry(n.entry.path, rootPath, true);
      toastOk(t("sidebar:filetree.deleted", { name: n.entry.name }));
    } catch (err) {
      handleError(err, "delete entry");
    }
    setConfirmPermanentOpen(false);
    pendingDeleteNodeRef.current = null;
  }, [rootPath, deleteEntry, t]);

  const openDialog = useCallback(
    (type: "rename" | "newFile" | "newDir" | "move" | "copy") => {
      const n = nodeRef.current;
      if (!n) return;
      dialogNodeRef.current = n;
      if (type === "rename") {
        setInputValue(n.entry.name);
      } else {
        setInputValue("");
      }
      setDialogType(type);
    },
    [nodeRef]
  );

  // 空白区（未命中任何节点）的根目录动作：合成根节点走同一套对话框流程
  const rootName = rootPath.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? rootPath;
  const openRootDialog = useCallback(
    (type: "newFile" | "newDir") => {
      dialogNodeRef.current = {
        entry: { path: rootPath, name: rootName, isDir: true },
        children: null,
        expanded: false,
        loading: false,
      } as FileTreeNode;
      setInputValue("");
      setDialogType(type);
    },
    [rootPath, rootName]
  );

  const refresh = useFileTreeStore((s) => s.refresh);
  const handleRefresh = useCallback(() => {
    void refresh(rootPath).catch((err) => handleErrorSilent(err, "refresh file tree"));
  }, [refresh, rootPath]);

  // 键盘入口（F2）：复用 rename 对话框，调用方需先把目标节点写入 nodeRef
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { openRename: () => openDialog("rename") };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, openDialog]);

  const handleDialogSubmit = useCallback(async () => {
    const n = dialogNodeRef.current;
    if (!n || !inputValue.trim()) return;
    try {
      switch (dialogType) {
        case "rename":
          await renameEntry(n.entry.path, inputValue.trim(), rootPath);
          toastOk(t("sidebar:filetree.renamed", { name: inputValue.trim() }));
          break;
        case "newFile": {
          const parentDir = n.entry.isDir ? n.entry.path : n.entry.path.replace(/[/\\][^/\\]*$/, "");
          await createFile(parentDir, inputValue.trim(), rootPath);
          toastOk(t("sidebar:filetree.created", { name: inputValue.trim() }));
          break;
        }
        case "newDir": {
          const parentDir = n.entry.isDir ? n.entry.path : n.entry.path.replace(/[/\\][^/\\]*$/, "");
          await createDirectory(parentDir, inputValue.trim(), rootPath);
          toastOk(t("sidebar:filetree.created", { name: inputValue.trim() }));
          break;
        }
        case "copy":
          await copyEntry(n.entry.path, inputValue.trim(), rootPath);
          toastOk(t("sidebar:filetree.copiedTo", { name: inputValue.trim() }));
          break;
        case "move":
          await moveEntry(n.entry.path, inputValue.trim(), rootPath);
          toastOk(t("sidebar:filetree.movedTo", { name: inputValue.trim() }));
          break;
      }
    } catch (err) {
      handleError(err, "file tree operation");
    }
    setDialogType(null);
    dialogNodeRef.current = null;
  }, [inputValue, dialogType, rootPath, renameEntry, createFile, createDirectory, copyEntry, moveEntry, t]);

  const handleOpenTerminal = useCallback(() => {
    const n = nodeRef.current;
    if (!n || !onOpenTerminal) return;
    const dir = n.entry.isDir ? n.entry.path : n.entry.path.replace(/[/\\][^/\\]*$/, "");
    onOpenTerminal(dir);
  }, [onOpenTerminal, nodeRef]);

  const dialogTitleKeys = {
    rename: "sidebar:filetree.dialogRename",
    newFile: "sidebar:filetree.dialogNewFile",
    newDir: "sidebar:filetree.dialogNewFolder",
    copy: "sidebar:filetree.dialogCopyTo",
    move: "sidebar:filetree.dialogMoveTo",
  } as const;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {/* 空白区（node 为 null）：只给根目录动作，不再显示一排点了没反应的死项 */}
          {!node && (
            <>
              <ContextMenuItem onClick={() => openRootDialog("newFile")}>
                <FilePlus size={14} />
                {t("sidebar:filetree.newFile")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => openRootDialog("newDir")}>
                <FolderPlus size={14} />
                {t("sidebar:filetree.newFolder")}
              </ContextMenuItem>
              {onOpenTerminal && (
                <ContextMenuItem onClick={() => onOpenTerminal(rootPath)}>
                  <Terminal size={14} />
                  {t("sidebar:filetree.openInTerminal")}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={handleRefresh}>
                <RefreshCw size={14} />
                {t("sidebar:refresh")}
              </ContextMenuItem>
            </>
          )}
          {node && !node.entry.isDir && (
            <>
              <ContextMenuItem onClick={handleOpenEditor}>
                <FileEdit size={14} />
                {t("sidebar:filetree.openInEditor")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}

          {node?.entry.isDir && onOpenTerminal && (
            <>
              <ContextMenuItem onClick={handleOpenTerminal}>
                <Terminal size={14} />
                {t("sidebar:filetree.openInTerminal")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}

          {node && (
            <>
              <ContextMenuItem onClick={handleOpenInExplorer}>
                <ExternalLink size={14} />
                {node.entry.isDir ? t("sidebar:filetree.openInExplorer") : t("sidebar:filetree.revealInExplorer")}
              </ContextMenuItem>
              <ContextMenuItem onClick={handleCopyPath}>
                <ClipboardCopy size={14} />
                {t("sidebar:filetree.copyAbsolutePath")}
              </ContextMenuItem>
              <ContextMenuItem onClick={handleCopyRelativePath}>
                <FileSymlink size={14} />
                {t("sidebar:filetree.copyRelativePath")}
              </ContextMenuItem>

              {node.entry.isDir && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => openDialog("newFile")}>
                    <FilePlus size={14} />
                    {t("sidebar:filetree.newFile")}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => openDialog("newDir")}>
                    <FolderPlus size={14} />
                    {t("sidebar:filetree.newFolder")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}

              {!node.entry.isDir && <ContextMenuSeparator />}

              <ContextMenuItem onClick={() => openDialog("rename")}>
                <FileEdit size={14} />
                {t("sidebar:filetree.rename")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => openDialog("copy")}>
                <Copy size={14} />
                {t("sidebar:filetree.copyTo")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => openDialog("move")}>
                <Move size={14} />
                {t("sidebar:filetree.moveTo")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={handleDelete}
                variant="destructive"
              >
                <Trash2 size={14} />
                {t("sidebar:filetree.delete")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* 输入对话框 */}
      <Dialog open={dialogType !== null} onOpenChange={() => setDialogType(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dialogType ? t(dialogTitleKeys[dialogType]) : ""}</DialogTitle>
          </DialogHeader>
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleDialogSubmit()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogType(null)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleDialogSubmit}>{t("common:confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认对话框 */}
      <Dialog open={confirmDeleteOpen} onOpenChange={(open) => {
        if (!open) {
          setConfirmDeleteOpen(false);
          pendingDeleteNodeRef.current = null;
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingDeleteNodeRef.current?.entry.isDir
                ? t("sidebar:filetree.deleteFolderTitle")
                : t("sidebar:filetree.deleteFileTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("sidebar:filetree.deleteConfirm", { name: pendingDeleteNodeRef.current?.entry.name ?? "" })}
              {isWslUncPath(pendingDeleteNodeRef.current?.entry.path) && (
                <> {t("sidebar:filetree.deleteNoTrashHint")}</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setConfirmDeleteOpen(false);
              pendingDeleteNodeRef.current = null;
            }}>
              {t("common:cancel")}
            </Button>
            <Button variant="destructive" onClick={doDelete}>
              {t("common:delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 回收站不可用 → 永久删除二次确认 */}
      <ConfirmDialog
        open={confirmPermanentOpen}
        setOpen={(v) => {
          setConfirmPermanentOpen(v);
          if (!v) pendingDeleteNodeRef.current = null;
        }}
        title={t("sidebar:filetree.permanentDeleteTitle")}
        description={t("sidebar:filetree.permanentDeleteConfirm", {
          name: pendingDeleteNodeRef.current?.entry.name ?? "",
        })}
        onConfirm={doPermanentDelete}
        variant="destructive"
      />
    </>
  );
}
