import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { handleError } from "@/utils";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuTrigger, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FileEdit, Trash2, Copy, Move, FolderPlus, FilePlus,
  ExternalLink, ClipboardCopy, FileSymlink, Terminal,
} from "lucide-react";
import { useFileTreeStore } from "@/stores";
import { usePanesStore } from "@/stores";
import type { FileTreeNode } from "@/types/filesystem";

interface FileTreeContextMenuProps {
  children: React.ReactNode;
  nodeRef: React.MutableRefObject<FileTreeNode | null>;
  rootPath: string;
  onOpenTerminal?: (path: string) => void;
}

export default function FileTreeContextMenu({
  children,
  nodeRef,
  rootPath,
  onOpenTerminal,
}: FileTreeContextMenuProps) {
  const { t } = useTranslation(["sidebar", "common"]);

  const [dialogType, setDialogType] = useState<"rename" | "newFile" | "newDir" | "move" | "copy" | null>(null);
  const [inputValue, setInputValue] = useState("");
  // 对话框打开时快照 node，避免后续右键改变 nodeRef 影响
  const dialogNodeRef = useRef<FileTreeNode | null>(null);

  // 删除确认对话框状态
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
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
    try {
      await invoke("open_path_in_explorer", { path: n.entry.path });
    } catch (err) {
      handleError(err, "open in explorer");
    }
  }, [nodeRef]);

  const handleCopyPath = useCallback(() => {
    const n = nodeRef.current;
    if (!n) return;
    navigator.clipboard.writeText(n.entry.path);
    toast.success(t("sidebar:filetree.pathCopied"));
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
    toast.success(t("sidebar:filetree.relativePathCopied"));
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
    try {
      await deleteEntry(n.entry.path, rootPath);
      toast.success(t("sidebar:filetree.deleted", { name: n.entry.name }));
    } catch (err) {
      handleError(err, "delete entry");
    }
    setConfirmDeleteOpen(false);
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

  const handleDialogSubmit = useCallback(async () => {
    const n = dialogNodeRef.current;
    if (!n || !inputValue.trim()) return;
    try {
      switch (dialogType) {
        case "rename":
          await renameEntry(n.entry.path, inputValue.trim(), rootPath);
          toast.success(t("sidebar:filetree.renamed", { name: inputValue.trim() }));
          break;
        case "newFile": {
          const parentDir = n.entry.isDir ? n.entry.path : n.entry.path.replace(/[/\\][^/\\]*$/, "");
          await createFile(parentDir, inputValue.trim(), rootPath);
          toast.success(t("sidebar:filetree.created", { name: inputValue.trim() }));
          break;
        }
        case "newDir": {
          const parentDir = n.entry.isDir ? n.entry.path : n.entry.path.replace(/[/\\][^/\\]*$/, "");
          await createDirectory(parentDir, inputValue.trim(), rootPath);
          toast.success(t("sidebar:filetree.created", { name: inputValue.trim() }));
          break;
        }
        case "copy":
          await copyEntry(n.entry.path, inputValue.trim(), rootPath);
          toast.success(t("sidebar:filetree.copiedTo", { name: inputValue.trim() }));
          break;
        case "move":
          await moveEntry(n.entry.path, inputValue.trim(), rootPath);
          toast.success(t("sidebar:filetree.movedTo", { name: inputValue.trim() }));
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

          <ContextMenuItem onClick={handleOpenInExplorer}>
            <ExternalLink size={14} />
            {node?.entry.isDir ? t("sidebar:filetree.openInExplorer") : t("sidebar:filetree.revealInExplorer")}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyPath}>
            <ClipboardCopy size={14} />
            {t("sidebar:filetree.copyAbsolutePath")}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyRelativePath}>
            <FileSymlink size={14} />
            {t("sidebar:filetree.copyRelativePath")}
          </ContextMenuItem>

          {node?.entry.isDir && (
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

          {!node?.entry.isDir && <ContextMenuSeparator />}

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
    </>
  );
}
