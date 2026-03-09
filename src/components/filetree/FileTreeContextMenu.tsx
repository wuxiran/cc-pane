import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { handleError } from "@/utils";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuTrigger, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FileEdit, Trash2, Copy, Move, FolderPlus, FilePlus,
  ExternalLink, ClipboardCopy, Terminal,
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
  const [dialogType, setDialogType] = useState<"rename" | "newFile" | "newDir" | "move" | "copy" | null>(null);
  const [inputValue, setInputValue] = useState("");
  // 对话框打开时快照 node，避免后续右键改变 nodeRef 影响
  const dialogNodeRef = useRef<FileTreeNode | null>(null);

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
    toast.success("Path copied");
  }, [nodeRef]);

  const handleDelete = useCallback(async () => {
    const n = nodeRef.current;
    if (!n) return;
    try {
      await deleteEntry(n.entry.path, rootPath);
      toast.success(`Deleted: ${n.entry.name}`);
    } catch (err) {
      handleError(err, "delete entry");
    }
  }, [rootPath, deleteEntry, nodeRef]);

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
          toast.success(`Renamed to: ${inputValue.trim()}`);
          break;
        case "newFile": {
          const parentDir = n.entry.isDir ? n.entry.path : n.entry.path.replace(/[/\\][^/\\]*$/, "");
          await createFile(parentDir, inputValue.trim(), rootPath);
          toast.success(`Created: ${inputValue.trim()}`);
          break;
        }
        case "newDir": {
          const parentDir = n.entry.isDir ? n.entry.path : n.entry.path.replace(/[/\\][^/\\]*$/, "");
          await createDirectory(parentDir, inputValue.trim(), rootPath);
          toast.success(`Created: ${inputValue.trim()}`);
          break;
        }
        case "copy":
          await copyEntry(n.entry.path, inputValue.trim(), rootPath);
          toast.success(`Copied to: ${inputValue.trim()}`);
          break;
        case "move":
          await moveEntry(n.entry.path, inputValue.trim(), rootPath);
          toast.success(`Moved to: ${inputValue.trim()}`);
          break;
      }
    } catch (err) {
      handleError(err, "file tree operation");
    }
    setDialogType(null);
    dialogNodeRef.current = null;
  }, [inputValue, dialogType, rootPath, renameEntry, createFile, createDirectory, copyEntry, moveEntry]);

  const handleOpenTerminal = useCallback(() => {
    const n = nodeRef.current;
    if (!n || !onOpenTerminal) return;
    const dir = n.entry.isDir ? n.entry.path : n.entry.path.replace(/[/\\][^/\\]*$/, "");
    onOpenTerminal(dir);
  }, [onOpenTerminal, nodeRef]);

  const dialogTitles: Record<string, string> = {
    rename: "Rename",
    newFile: "New File",
    newDir: "New Folder",
    copy: "Copy to (destination directory)",
    move: "Move to (destination directory)",
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {node && !node.entry.isDir && (
            <>
              <ContextMenuItem onClick={handleOpenEditor}>
                <FileEdit size={14} />
                Open in Editor
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}

          {node?.entry.isDir && (
            <>
              <ContextMenuItem onClick={() => openDialog("newFile")}>
                <FilePlus size={14} />
                New File
              </ContextMenuItem>
              <ContextMenuItem onClick={() => openDialog("newDir")}>
                <FolderPlus size={14} />
                New Folder
              </ContextMenuItem>
              {onOpenTerminal && (
                <ContextMenuItem onClick={handleOpenTerminal}>
                  <Terminal size={14} />
                  Open in Terminal
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
            </>
          )}

          <ContextMenuItem onClick={handleOpenInExplorer}>
            <ExternalLink size={14} />
            {node?.entry.isDir ? "Open in Explorer" : "Reveal in Explorer"}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyPath}>
            <ClipboardCopy size={14} />
            Copy Path
          </ContextMenuItem>
          <ContextMenuSeparator />

          <ContextMenuItem onClick={() => openDialog("rename")}>
            <FileEdit size={14} />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={() => openDialog("copy")}>
            <Copy size={14} />
            Copy to...
          </ContextMenuItem>
          <ContextMenuItem onClick={() => openDialog("move")}>
            <Move size={14} />
            Move to...
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={handleDelete}
            variant="destructive"
          >
            <Trash2 size={14} />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* 输入对话框 */}
      <Dialog open={dialogType !== null} onOpenChange={() => setDialogType(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dialogType ? dialogTitles[dialogType] : ""}</DialogTitle>
          </DialogHeader>
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleDialogSubmit()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogType(null)}>
              Cancel
            </Button>
            <Button onClick={handleDialogSubmit}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
